'use strict';

/**
 * hl7AdtListener.fixtures.js
 *
 * Realistic synthetic HL7 v2.5 ADT messages, built field-position-correct
 * (not just plausible-looking), for exercising hl7AdtListener.js end to
 * end before any real hospital feed exists -- see
 * scripts/sendSyntheticAdt.js and hl7AdtListener.test.js.
 *
 * buildSegment() fills a segment out to a given field count so every
 * fixture below is unambiguous about exactly which HL7 field position
 * each value sits in (PV1-44/PV1-45 in particular are easy to miscount by
 * hand), rather than hand-typing dozens of pipe characters.
 */

// `startField` exists for MSH: MSH-1 is the field-separator character
// itself (the "|" right after "MSH"), not a value written into the
// segment, so MSH's own field list has to start from MSH-2 -- every other
// segment starts counting from field 1 like normal.
function buildSegment(segmentId, fields, fieldCount, startField = 1) {
  const values = [];
  for (let i = startField; i <= fieldCount; i++) values.push(fields[i] || '');
  return `${segmentId}|${values.join('|')}`;
}

function buildMsh({ triggerEvent, controlId, sendingFacility = 'HOSP', messageDateTime = '20240115080000' }) {
  return buildSegment(
    'MSH',
    {
      2: '^~\\&',
      3: 'ADTAPP',
      4: sendingFacility,
      5: 'PATIENTCHAIN',
      6: sendingFacility,
      7: messageDateTime,
      9: `ADT^${triggerEvent}`,
      10: controlId,
      11: 'P',
      12: '2.5',
    },
    12,
    2
  );
}

function buildPid({ hospitalNumber, family, given, middle = '', dob, sex }) {
  return buildSegment(
    'PID',
    {
      1: '1',
      3: hospitalNumber,
      5: `${family}^${given}${middle ? `^${middle}` : ''}`,
      7: dob,
      8: sex,
    },
    8
  );
}

function buildPv1({ patientClass, pointOfCare, room, bed, attendingId, attendingFamily, attendingGiven, admitDateTime, dischargeDateTime }) {
  return buildSegment(
    'PV1',
    {
      1: '1',
      2: patientClass,
      3: [pointOfCare, room, bed].filter(Boolean).join('^'),
      7: attendingId ? `${attendingId}^${attendingFamily}^${attendingGiven}` : '',
      44: admitDateTime,
      45: dischargeDateTime,
    },
    45
  );
}

const CRLF = '\r';

/** A01 -- admit. A brand-new inpatient encounter for a patient whose
 *  hospital number hasn't necessarily linked a PatientChain DID yet. */
const adtA01Admit =
  [
    buildMsh({ triggerEvent: 'A01', controlId: 'MSG00001' }),
    buildSegment('EVN', { 1: 'A01', 2: '20240115080000' }, 2),
    buildPid({ hospitalNumber: 'LAG-00231', family: 'OKAFOR', given: 'ADAEZE', middle: 'N', dob: '19900412', sex: 'F' }),
    buildPv1({
      patientClass: 'I',
      pointOfCare: 'WARD1',
      room: '101',
      bed: 'A',
      attendingId: '1234',
      attendingFamily: 'SMITH',
      attendingGiven: 'JOHN',
      admitDateTime: '20240115080000',
    }),
  ].join(CRLF) + CRLF;

/** A08 -- update. Same patient, a demographic correction (no new visit
 *  event) -- exercises the roster-only path (no PV1 change expected, but
 *  this fixture still includes PV1 to confirm an in-progress encounter
 *  can also be re-reported on an update without erroring). */
const adtA08Update =
  [
    buildMsh({ triggerEvent: 'A08', controlId: 'MSG00002', messageDateTime: '20240116093000' }),
    buildSegment('EVN', { 1: 'A08', 2: '20240116093000' }, 2),
    buildPid({ hospitalNumber: 'LAG-00231', family: 'OKAFOR', given: 'ADAEZE', middle: 'N', dob: '19900412', sex: 'F' }),
    buildPv1({
      patientClass: 'I',
      pointOfCare: 'WARD1',
      room: '101',
      bed: 'A',
      attendingId: '1234',
      attendingFamily: 'SMITH',
      attendingGiven: 'JOHN',
      admitDateTime: '20240115080000',
    }),
  ].join(CRLF) + CRLF;

/** A03 -- discharge. Closes out the encounter opened by adtA01Admit. */
const adtA03Discharge =
  [
    buildMsh({ triggerEvent: 'A03', controlId: 'MSG00003', messageDateTime: '20240118120000' }),
    buildSegment('EVN', { 1: 'A03', 2: '20240118120000' }, 2),
    buildPid({ hospitalNumber: 'LAG-00231', family: 'OKAFOR', given: 'ADAEZE', middle: 'N', dob: '19900412', sex: 'F' }),
    buildPv1({
      patientClass: 'I',
      pointOfCare: 'WARD1',
      room: '101',
      bed: 'A',
      attendingId: '1234',
      attendingFamily: 'SMITH',
      attendingGiven: 'JOHN',
      admitDateTime: '20240115080000',
      dischargeDateTime: '20240118120000',
    }),
  ].join(CRLF) + CRLF;

/** A different patient at a different hospital number, admitted as an
 *  outpatient (PV1-2 "O") with no attending doctor recorded -- exercises
 *  the "PV1 present but sparse" and "class other than inpatient" paths. */
const adtA01OutpatientNoAttending =
  [
    buildMsh({ triggerEvent: 'A01', controlId: 'MSG00004' }),
    buildSegment('EVN', { 1: 'A01', 2: '20240115081500' }, 2),
    buildPid({ hospitalNumber: 'LAG-00450', family: 'BELLO', given: 'CHIDI', dob: '19851103', sex: 'M' }),
    buildPv1({ patientClass: 'O', pointOfCare: 'CLINIC2', admitDateTime: '20240115081500' }),
  ].join(CRLF) + CRLF;

/** A demographic-only A08 with no PV1 segment at all -- exercises the
 *  "no encounter, roster update only" path. */
const adtA08NoPv1 =
  [
    buildMsh({ triggerEvent: 'A08', controlId: 'MSG00005' }),
    buildSegment('EVN', { 1: 'A08', 2: '20240117100000' }, 2),
    buildPid({ hospitalNumber: 'LAG-00450', family: 'BELLO', given: 'CHIDI', dob: '19851103', sex: 'M' }),
  ].join(CRLF) + CRLF;

/** A vendor Z-segment and a garbled non-segment line spliced in between
 *  valid ones -- the real-world "inconsistent between vendors" case the
 *  task calls out. PID/PV1 must still be found and mapped correctly. */
const adtA01WithUnrecognisedSegments =
  [
    buildMsh({ triggerEvent: 'A01', controlId: 'MSG00006' }),
    buildSegment('EVN', { 1: 'A01', 2: '20240115083000' }, 2),
    'ZPI|1|SOME|VENDOR|SPECIFIC|EXTENSION', // unrecognised Z-segment
    buildPid({ hospitalNumber: 'LAG-00777', family: 'ADEYEMI', given: 'TOLA', dob: '19751230', sex: 'F' }),
    '###NOT-A-VALID-SEGMENT-AT-ALL###', // outright garbage line
    buildPv1({ patientClass: 'I', pointOfCare: 'WARD3', room: '12', bed: 'B', admitDateTime: '20240115083000' }),
  ].join(CRLF) + CRLF;

/** Genuinely unparseable input (no MSH at all) -- exercises the
 *  "log and skip rather than crash" requirement at the parser boundary. */
const notHl7AtAll = 'this is not an HL7 message';

/** A non-ADT message (e.g. an ORU result) -- exercises the "wrong message
 *  type" skip path, distinct from a parse failure. */
const oruResultNotAdt =
  [
    buildSegment('MSH', { 2: '^~\\&', 3: 'LAB', 4: 'HOSP', 9: 'ORU^R01', 10: 'MSG00007', 11: 'P', 12: '2.5' }, 12, 2),
    buildPid({ hospitalNumber: 'LAG-00231', family: 'OKAFOR', given: 'ADAEZE', dob: '19900412', sex: 'F' }),
  ].join(CRLF) + CRLF;

module.exports = {
  buildSegment,
  buildMsh,
  buildPid,
  buildPv1,
  adtA01Admit,
  adtA08Update,
  adtA03Discharge,
  adtA01OutpatientNoAttending,
  adtA08NoPv1,
  adtA01WithUnrecognisedSegments,
  notHl7AtAll,
  oruResultNotAdt,
};
