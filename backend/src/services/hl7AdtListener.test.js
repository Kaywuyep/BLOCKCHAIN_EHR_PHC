'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FhirAdapter } = require('./fhirAdapter');
const {
  hl7DateToIso,
  hl7SexToFhirGender,
  hl7PatientClassToFhirClass,
  parseHl7Message,
  mapAdtMessageToResources,
  ingestParsedMessage,
  ingestRawAdtText,
} = require('./hl7AdtListener');
const {
  adtA01Admit,
  adtA08Update,
  adtA03Discharge,
  adtA01OutpatientNoAttending,
  adtA08NoPv1,
  adtA01WithUnrecognisedSegments,
  notHl7AtAll,
  oruResultNotAdt,
} = require('./hl7AdtListener.fixtures');

// A logger that records warnings instead of printing them, so tests can
// assert on the "log and skip rather than crash" behaviour without
// spamming test output.
function silentLog() {
  const warnings = [];
  return { warnings, log() {}, warn: (msg) => warnings.push(msg) };
}

test('hl7DateToIso converts an HL7 YYYYMMDD(HHMMSS) value to YYYY-MM-DD', () => {
  assert.equal(hl7DateToIso('19900412'), '1990-04-12');
  assert.equal(hl7DateToIso('19900412153000'), '1990-04-12');
  assert.equal(hl7DateToIso(''), null);
  assert.equal(hl7DateToIso('199'), null);
});

test('hl7SexToFhirGender maps HL7 Table 0001 to FHIR AdministrativeGender', () => {
  assert.equal(hl7SexToFhirGender('M'), 'male');
  assert.equal(hl7SexToFhirGender('F'), 'female');
  assert.equal(hl7SexToFhirGender('O'), 'other');
  assert.equal(hl7SexToFhirGender('U'), 'unknown');
  assert.equal(hl7SexToFhirGender(''), 'unknown');
});

test('hl7PatientClassToFhirClass maps HL7 Table 0004 to a FHIR ActCode, defaulting unknown classes to ambulatory', () => {
  assert.equal(hl7PatientClassToFhirClass('I').code, 'IMP');
  assert.equal(hl7PatientClassToFhirClass('E').code, 'EMER');
  assert.equal(hl7PatientClassToFhirClass('O').code, 'AMB');
  assert.equal(hl7PatientClassToFhirClass('Q').code, 'AMB');
});

test('mapAdtMessageToResources maps an A01 admit into FHIR Patient + Encounter shapes per the PID/PV1 field table', () => {
  const mapped = mapAdtMessageToResources(parseHl7Message(adtA01Admit), { log: silentLog() });

  assert.equal(mapped.triggerEvent, 'A01');
  assert.equal(mapped.hospitalNumber, 'LAG-00231');
  assert.equal(mapped.patient.name, 'ADAEZE N OKAFOR');
  assert.equal(mapped.patient.dob, '1990-04-12');
  assert.equal(mapped.patient.sex, 'female');
  assert.equal(mapped.patient.sourceResource.resourceType, 'Patient');
  assert.equal(mapped.patient.sourceResource.name[0].family, 'OKAFOR');
  assert.deepEqual(mapped.patient.sourceResource.name[0].given, ['ADAEZE', 'N']);

  const enc = mapped.encounterResource;
  assert.equal(enc.resourceType, 'Encounter');
  assert.equal(enc.status, 'in-progress');
  assert.equal(enc.class.code, 'IMP');
  assert.equal(enc.location[0].location.display, 'WARD1 101 A');
  assert.equal(enc.participant[0].individual.display, 'JOHN SMITH');
  assert.equal(enc.period.start, '2024-01-15');
});

test('mapAdtMessageToResources marks an A03 discharge as finished, with a period end', () => {
  const mapped = mapAdtMessageToResources(parseHl7Message(adtA03Discharge), { log: silentLog() });
  assert.equal(mapped.encounterResource.status, 'finished');
  assert.equal(mapped.encounterResource.period.start, '2024-01-15');
  assert.equal(mapped.encounterResource.period.end, '2024-01-18');
});

test('mapAdtMessageToResources handles an A08 update carrying the same visit without erroring', () => {
  const mapped = mapAdtMessageToResources(parseHl7Message(adtA08Update), { log: silentLog() });
  assert.equal(mapped.triggerEvent, 'A08');
  assert.equal(mapped.encounterResource.status, 'in-progress');
});

test('mapAdtMessageToResources produces no Encounter when PV1 (patient class) is absent -- roster-only update', () => {
  const mapped = mapAdtMessageToResources(parseHl7Message(adtA08NoPv1), { log: silentLog() });
  assert.equal(mapped.encounterResource, null);
  assert.equal(mapped.hospitalNumber, 'LAG-00450');
});

test('mapAdtMessageToResources maps an outpatient class to AMB and omits the participant when no attending doctor is present', () => {
  const mapped = mapAdtMessageToResources(parseHl7Message(adtA01OutpatientNoAttending), { log: silentLog() });
  assert.equal(mapped.encounterResource.class.code, 'AMB');
  assert.equal(mapped.encounterResource.participant, undefined);
});

test('mapAdtMessageToResources tolerates an unrecognised vendor Z-segment and a garbled non-segment line between valid segments', () => {
  const mapped = mapAdtMessageToResources(parseHl7Message(adtA01WithUnrecognisedSegments), { log: silentLog() });
  assert.equal(mapped.hospitalNumber, 'LAG-00777');
  assert.equal(mapped.patient.name, 'TOLA ADEYEMI');
  assert.equal(mapped.encounterResource.location[0].location.display, 'WARD3 12 B');
});

test('mapAdtMessageToResources returns null and logs a warning for a non-ADT message instead of throwing', () => {
  const log = silentLog();
  const mapped = mapAdtMessageToResources(parseHl7Message(oruResultNotAdt), { log });
  assert.equal(mapped, null);
  assert.ok(log.warnings.some((w) => w.includes('non-ADT')));
});

test('parseHl7Message throws on genuinely unparseable input -- callers are responsible for catching it', () => {
  assert.throws(() => parseHl7Message(notHl7AtAll));
});

test('ingestRawAdtText logs and returns ok:false for unparseable text, without throwing', () => {
  const adapter = new FhirAdapter();
  const log = silentLog();
  const result = ingestRawAdtText(adapter, 'hospital-a', notHl7AtAll, { log });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unparseable HL7 message/);
});

test('ingestRawAdtText writes the mapped Patient into fhirAdapter.addLocalPatientRecord -- the same roster the REST/DB path and the Admin Dashboard use', () => {
  const adapter = new FhirAdapter();
  const result = ingestRawAdtText(adapter, 'hospital-a', adtA01Admit, { log: silentLog() });

  assert.equal(result.ok, true);
  assert.equal(result.hospitalNumber, 'LAG-00231');
  assert.equal(result.encounterRecorded, true);

  const roster = adapter.findLocalPatientRecord('hospital-a', 'LAG-00231');
  assert.equal(roster.name, 'ADAEZE N OKAFOR');
  assert.equal(roster.dob, '1990-04-12');
});

test('ingestRawAdtText writes the mapped Encounter via recordResourceByHospitalNumber, and it becomes visible through resolveRecord once a DID links', () => {
  const adapter = new FhirAdapter();
  ingestRawAdtText(adapter, 'hospital-a', adtA01Admit, { log: silentLog() });

  // Not linked to a DID yet.
  assert.throws(() => adapter.resolveRecord('hospital-a', 'did:patientchain:p1'));

  adapter.registerLocalPatient('hospital-a', 'did:patientchain:p1', 'LAG-00231');
  const { bundles } = adapter.resolveRecord('hospital-a', 'did:patientchain:p1');
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].entry[0].resource.resourceType, 'Encounter');
});

test('ingestParsedMessage skips a demographic-only A08 (no PV1) without recording an encounter', () => {
  const adapter = new FhirAdapter();
  const result = ingestParsedMessage(adapter, 'hospital-a', parseHl7Message(adtA08NoPv1), { log: silentLog() });
  assert.equal(result.ok, true);
  assert.equal(result.encounterRecorded, false);
  assert.ok(adapter.findLocalPatientRecord('hospital-a', 'LAG-00450'));
});

test('two ADT messages for the same patient at two different hospitals stay isolated, mirroring the rest of fhirAdapter', () => {
  const adapter = new FhirAdapter();
  ingestRawAdtText(adapter, 'hospital-a', adtA01Admit, { log: silentLog() });
  ingestRawAdtText(adapter, 'hospital-b', adtA01WithUnrecognisedSegments, { log: silentLog() });

  assert.ok(adapter.findLocalPatientRecord('hospital-a', 'LAG-00231'));
  assert.equal(adapter.findLocalPatientRecord('hospital-a', 'LAG-00777'), null);
  assert.ok(adapter.findLocalPatientRecord('hospital-b', 'LAG-00777'));
});
