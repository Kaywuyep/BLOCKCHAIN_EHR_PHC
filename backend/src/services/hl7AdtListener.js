'use strict';

const { randomUUID } = require('crypto');
const { Message } = require('node-hl7-client');
const { Server } = require('node-hl7-server');

/**
 * hl7AdtListener.js
 *
 * A second ingestion path into fhirAdapter.js, alongside the REST/DB path
 * described in docs/fhir-adapter-live-emr-guide.md. HL7 v2 ADT feeds --
 * not FHIR -- are what most real hospital systems actually speak,
 * especially larger private facilities in Nigeria running older or
 * vendor-locked EMRs (see docs/design.md Section 4 and the discussion in
 * chat of Nigeria's pending national EHR standardisation effort). This
 * module receives HL7 v2 ADT (Admit/Discharge/Transfer) messages -- over
 * MLLP (the traditional TCP transport) or a plain HTTP POST of the raw
 * message text (for local/synthetic testing, see routes/hl7.js) -- parses
 * the MSH/PID/PV1 segments, and maps them into the exact same kind of
 * FHIR R4 Patient/Encounter data fhirAdapter.js's REST/DB path already
 * produces, before writing through fhirAdapter's existing public methods
 * (addLocalPatientRecord, recordResourceByHospitalNumber). Nothing
 * downstream -- linkageService.js, the routes, the audit trail -- can
 * tell which protocol a given hospital used; both paths converge on
 * fhirAdapter's storage before anything downstream ever sees the data.
 *
 * ── Segment field mapping (HL7 v2.x -> FHIR R4) ──────────────────────────
 *
 * MSH (message header):
 *   MSH-9.1   message type            must be "ADT", else the message is
 *                                      logged and skipped
 *   MSH-9.2   trigger event           A01/A03/A08 get the explicit
 *                                      handling documented below; any
 *                                      other ADT trigger (A02, A04, A11,
 *                                      ...) still updates the roster via
 *                                      the generic path -- see
 *                                      encounterStatusForTrigger()
 *   MSH-10    message control ID      -> duplicate detection in
 *                                        hl7Inbox.js (a resend is
 *                                        acknowledged, not reapplied)
 *
 * PID (patient identification) -> FHIR Patient:
 *   PID-3.1   patient/hospital number -> Patient.identifier[0].value,
 *                                        and the hospitalNumber key
 *                                        everything is filed under
 *                                        (fhirAdapter's roster and
 *                                        database Maps are both already
 *                                        keyed by this exact string)
 *   PID-5.1   family name             -> Patient.name[0].family
 *   PID-5.2   given name              -> Patient.name[0].given[0]
 *   PID-5.3   middle name             -> Patient.name[0].given[1]
 *                                        (PID-5.4 suffix, PID-5.5 prefix,
 *                                        PID-5.6 degree are NOT mapped --
 *                                        add them here if a real feed
 *                                        needs them)
 *   PID-7     date of birth (YYYYMMDD -> Patient.birthDate (YYYY-MM-DD),
 *              or an HL7 timestamp)     via hl7DateToIso() -- this is the
 *                                        same YYYY-MM-DD shape the
 *                                        Patient App's date inputs and
 *                                        linkFacility's dateOfBirth
 *                                        parameter already use, so no
 *                                        downstream format conversion is
 *                                        ever needed
 *   PID-8     sex (HL7 Table 0001)     -> Patient.gender (FHIR
 *                                        AdministrativeGender), via
 *                                        hl7SexToFhirGender()
 *
 *   The mapped { name, dob } (plus `sex` and the full `sourceResource`)
 *   are handed to fhirAdapter.addLocalPatientRecord() -- the same roster
 *   entry point the Admin Dashboard's manual "Add record" form and the
 *   live-EMR REST/DB path both write through.
 *
 * PV1 (patient visit) -> FHIR Encounter, when PV1-2 is present:
 *   PV1-2     patient class            -> Encounter.class.code, via
 *              (HL7 Table 0004)          hl7PatientClassToFhirClass()
 *                                        (I -> IMP, O -> AMB, E -> EMER,
 *                                        anything else -> AMB as a
 *                                        conservative fallback)
 *   PV1-3.1   point of care            -> Encounter.location[0]
 *   PV1-3.2   room                        .location.display, joined as
 *   PV1-3.3   bed                         "<point of care> <room> <bed>"
 *   PV1-7.1   attending doctor ID       -> Encounter.participant[0]
 *   PV1-7.2   attending family name       .individual.identifier.value /
 *   PV1-7.3   attending given name        .display (only added if PV1-7
 *                                          is present at all)
 *   PV1-44    admit date/time          -> Encounter.period.start
 *   PV1-45    discharge date/time      -> Encounter.period.end (present
 *                                          on A03 and any other trigger
 *                                          that carries it)
 *
 *   Encounter.status comes from the trigger event, not a PV1 field
 *   (HL7 v2 doesn't carry an encounter-status code the way FHIR does):
 *   A01 -> "in-progress", A03 -> "finished" (or PV1-45 present is treated
 *   the same as A03), anything else -> "in-progress". The mapped resource
 *   is handed to fhirAdapter.recordResourceByHospitalNumber() -- notably
 *   *not* createClinicalRecord(), because that method requires a DID to
 *   already be linked, and an ADT feed has no idea whether a patient has
 *   ever linked a PatientChain DID. recordResourceByHospitalNumber files
 *   the Encounter under the hospital number directly; if/when the patient
 *   later links a DID to it (POST /:did/confirm-link), the Encounter
 *   becomes visible through GET /records/resolve automatically -- see
 *   fhirAdapter.js's docstring on that method for why this is safe.
 *
 * ── Error handling ───────────────────────────────────────────────────────
 * A message that isn't parseable HL7 at all (missing/garbled MSH), or
 * that's missing the fields required to build a Patient (no hospital
 * number, no name), is logged with the reason and skipped -- it never
 * throws out of ingestRawAdtText/ingestParsedMessage into the HTTP route
 * or the MLLP handler. Unrecognised segments (vendor Z-segments, a
 * garbled line) are tolerated by the underlying parser and simply
 * ignored; see hl7AdtListener.test.js for a message exercising this.
 */

// ── HL7 <-> FHIR value mapping helpers ─────────────────────────────────

/** "19900412" or "19900412153000" -> "1990-04-12". Returns null if the
 *  input isn't at least an 8-digit YYYYMMDD. */
function hl7DateToIso(hl7Date) {
  if (!hl7Date || hl7Date.length < 8) return null;
  const year = hl7Date.slice(0, 4);
  const month = hl7Date.slice(4, 6);
  const day = hl7Date.slice(6, 8);
  return `${year}-${month}-${day}`;
}

/** HL7 Table 0001 (Administrative Sex) -> FHIR AdministrativeGender. */
function hl7SexToFhirGender(hl7Sex) {
  switch ((hl7Sex || '').toUpperCase()) {
    case 'M':
      return 'male';
    case 'F':
      return 'female';
    case 'O':
      return 'other';
    default:
      return 'unknown';
  }
}

/** HL7 Table 0004 (Patient Class) -> FHIR Encounter.class (ActCode). */
function hl7PatientClassToFhirClass(patientClass) {
  switch ((patientClass || '').toUpperCase()) {
    case 'I':
      return { code: 'IMP', display: 'inpatient encounter' };
    case 'E':
      return { code: 'EMER', display: 'emergency' };
    case 'O':
    default:
      return { code: 'AMB', display: 'ambulatory' };
  }
}

/** Trigger event -> Encounter.status. See the module docstring above. */
function encounterStatusForTrigger(triggerEvent, hasDischargeDateTime) {
  if (triggerEvent === 'A03' || hasDischargeDateTime) return 'finished';
  return 'in-progress';
}

// ── Hospital-specific field mapping ─────────────────────────────────────

/**
 * Where each mapped value is read from. Interface engines differ: one
 * hospital puts its hospital number in PID-2 instead of PID-3, another
 * sends the attending doctor in PV1-17. A hospital's entry in
 * config/hospitalIngestion.json can override any of these with
 * `"fieldMap": { "hospitalNumber": "PID.2.1" }`; everything not listed
 * keeps the standard location below.
 */
const DEFAULT_FIELD_MAP = Object.freeze({
  messageType: 'MSH.9.1',
  triggerEvent: 'MSH.9.2',
  controlId: 'MSH.10',
  hospitalNumber: 'PID.3.1',
  familyName: 'PID.5.1',
  givenName: 'PID.5.2',
  middleName: 'PID.5.3',
  dob: 'PID.7',
  sex: 'PID.8',
  patientClass: 'PV1.2',
  pointOfCare: 'PV1.3.1',
  room: 'PV1.3.2',
  bed: 'PV1.3.3',
  attendingId: 'PV1.7.1',
  attendingFamily: 'PV1.7.2',
  attendingGiven: 'PV1.7.3',
  admitDateTime: 'PV1.44',
  dischargeDateTime: 'PV1.45',
});

const FIELD_PATH = /^[A-Z][A-Z0-9]{2}\.\d+(\.\d+){0,2}$/;

function resolveFieldMap(overrides = {}) {
  const map = { ...DEFAULT_FIELD_MAP };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!(key in DEFAULT_FIELD_MAP)) throw new Error(`unknown HL7 fieldMap key "${key}"`);
    if (typeof value !== 'string' || !FIELD_PATH.test(value)) throw new Error(`invalid HL7 field path "${value}" for ${key}`);
    map[key] = value;
  }
  return map;
}

// ── Parsing + mapping ───────────────────────────────────────────────────

/** Parses raw HL7 v2 text into a Message. Throws on genuinely unparseable
 *  input (e.g. missing MSH) -- callers must catch this, per the "log and
 *  skip rather than crash" requirement; see ingestRawAdtText(). */
function parseHl7Message(rawText) {
  return new Message({ text: rawText });
}

/**
 * Maps an already-parsed HL7 v2 Message into the same shapes described in
 * the module docstring's segment-mapping table. Returns null (and logs)
 * if the message isn't an ADT message, or is missing the fields required
 * to build a usable Patient resource.
 */
function mapAdtMessageToResources(message, { log = console, fieldMap } = {}) {
  const map = resolveFieldMap(fieldMap);
  const field = (key) => message.get(map[key]).toString();
  const messageType = field('messageType');
  const triggerEvent = field('triggerEvent');
  const controlId = field('controlId');

  if (messageType !== 'ADT') {
    log.warn(`[hl7AdtListener] skipping non-ADT message (MSH.9.1="${messageType}", control ID ${controlId || '(none)'})`);
    return null;
  }

  const hospitalNumber = field('hospitalNumber');
  const familyName = field('familyName');
  const givenName = field('givenName');
  const middleName = field('middleName');
  const dobRaw = field('dob');
  const sexRaw = field('sex');

  if (!hospitalNumber || !familyName) {
    log.warn(
      `[hl7AdtListener] skipping ADT^${triggerEvent} (control ID ${controlId || '(none)'}): ` +
        `missing PID-3 (hospital number) or PID-5 (name)`
    );
    return null;
  }

  const given = [givenName, middleName].filter(Boolean);
  const fullName = [givenName, middleName, familyName].filter(Boolean).join(' ');
  const dob = hl7DateToIso(dobRaw);

  const patientResource = {
    resourceType: 'Patient',
    identifier: [{ value: hospitalNumber }],
    name: [{ family: familyName, given, text: fullName }],
    birthDate: dob,
    gender: hl7SexToFhirGender(sexRaw),
  };

  // PV1 is optional -- an A08 demographic-only update, for instance, may
  // not carry a visit at all. Patient class (PV1-2) is the presence
  // signal: no class, no encounter.
  const patientClass = field('patientClass');
  let encounterResource = null;
  let practitionerResource = null;
  if (patientClass) {
    const pointOfCare = field('pointOfCare');
    const room = field('room');
    const bed = field('bed');
    const locationDisplay = [pointOfCare, room, bed].filter(Boolean).join(' ');

    const attendingId = field('attendingId');
    const attendingFamily = field('attendingFamily');
    const attendingGiven = field('attendingGiven');

    const admitDateTime = field('admitDateTime');
    const dischargeDateTime = field('dischargeDateTime');

    encounterResource = {
      resourceType: 'Encounter',
      id: randomUUID(),
      status: encounterStatusForTrigger(triggerEvent, Boolean(dischargeDateTime)),
      class: hl7PatientClassToFhirClass(patientClass),
      subject: { identifier: { value: hospitalNumber } },
      period: {
        ...(admitDateTime ? { start: hl7DateToIso(admitDateTime) || admitDateTime } : {}),
        ...(dischargeDateTime ? { end: hl7DateToIso(dischargeDateTime) || dischargeDateTime } : {}),
      },
    };
    if (locationDisplay) {
      encounterResource.location = [{ location: { display: locationDisplay } }];
    }
    if (attendingId || attendingFamily) {
      // Table 3.6 "Administrative": the attending clinician as a FHIR
      // Practitioner, referenced from the Encounter.
      practitionerResource = {
        resourceType: 'Practitioner',
        id: randomUUID(),
        identifier: attendingId ? [{ value: attendingId }] : [],
        name: [{ family: attendingFamily || undefined, given: attendingGiven ? [attendingGiven] : undefined, text: [attendingGiven, attendingFamily].filter(Boolean).join(' ') }],
      };
      encounterResource.participant = [
        {
          individual: {
            reference: `Practitioner/${practitionerResource.id}`,
            identifier: { value: attendingId },
            display: [attendingGiven, attendingFamily].filter(Boolean).join(' '),
          },
        },
      ];
    }
  }

  return {
    triggerEvent,
    controlId,
    hospitalNumber,
    patient: { name: fullName, dob, sex: hl7SexToFhirGender(sexRaw), sourceResource: patientResource },
    encounterResource,
    practitionerResource,
  };
}

// ── Ingestion (writes through fhirAdapter's existing public methods) ────

/**
 * Ingests an already-parsed Message (e.g. from the MLLP listener, whose
 * transport already handed you a parsed Message via req.getMessage()).
 * Never throws -- returns a result object describing what happened, so
 * callers can ACK/NACK or respond to an HTTP request accordingly.
 */
function ingestParsedMessage(fhirAdapter, hospitalID, message, { log = console, fieldMap } = {}) {
  let mapped;
  try {
    mapped = mapAdtMessageToResources(message, { log, fieldMap });
  } catch (err) {
    log.warn(`[hl7AdtListener] failed to map message for ${hospitalID}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
  if (!mapped) {
    return { ok: false, reason: 'message was not a usable ADT message -- see log for details' };
  }

  fhirAdapter.addLocalPatientRecord(hospitalID, mapped.hospitalNumber, mapped.patient);

  let encounterRecorded = false;
  if (mapped.encounterResource) {
    // The Encounter carries its Practitioner (and the hospital as
    // serviceProvider Organization) in the same bundle, so they travel
    // together and one on-chain pointer covers the visit.
    mapped.encounterResource.serviceProvider = mapped.encounterResource.serviceProvider || { reference: `Organization/${hospitalID}`, display: hospitalID };
    const extra = [mapped.practitionerResource, { resourceType: 'Organization', id: hospitalID, identifier: [{ value: hospitalID }], name: hospitalID }].filter(Boolean);
    fhirAdapter.recordResourceByHospitalNumber(hospitalID, mapped.hospitalNumber, mapped.encounterResource, extra);
    encounterRecorded = true;
  }

  return {
    ok: true,
    hospitalID,
    hospitalNumber: mapped.hospitalNumber,
    triggerEvent: mapped.triggerEvent,
    controlId: mapped.controlId,
    encounterRecorded,
  };
}

/**
 * Ingests a raw HL7 v2 message string -- the HTTP path (routes/hl7.js)
 * and the synthetic-message test script both start here. Parsing errors
 * are caught here so a malformed message never crashes the caller.
 */
function ingestRawAdtText(fhirAdapter, hospitalID, rawText, { log = console, fieldMap } = {}) {
  let message;
  try {
    message = parseHl7Message(rawText);
  } catch (err) {
    log.warn(`[hl7AdtListener] could not parse HL7 message for ${hospitalID}: ${err.message}`);
    return { ok: false, reason: `unparseable HL7 message: ${err.message}` };
  }
  return ingestParsedMessage(fhirAdapter, hospitalID, message, { log, fieldMap });
}

// ── MLLP transport (the traditional hospital-side wire protocol) ────────

/** "::ffff:10.0.0.5" -> "10.0.0.5", so IPv4 allowlists match on dual-stack sockets. */
function normalizeIp(address) {
  return (address || '').replace(/^::ffff:/, '');
}

/**
 * Starts an MLLP listener for one hospital's ADT feed. Call once per
 * hospital that's configured for HL7 ingestion (see
 * config/hospitalIngestion.example.json) -- each hospital gets its own
 * port, matching how real ADT interfaces are usually provisioned.
 *
 * Production options:
 *   inbox       Hl7Inbox: store-then-process with duplicate detection,
 *               retry and dead-letter (see hl7Inbox.js). Without it the
 *               message is processed directly (tests, legacy callers).
 *   tls         { cert, key, ca? } PEM buffers. With `ca`, clients must
 *               present a certificate signed by it (mutual TLS).
 *   allowedIps  interface-engine source addresses; any other connection
 *               is dropped before a byte is read.
 *   bindAddress interface to listen on, e.g. the VPN address.
 *
 * Returns the `Inbound` instance (from node-hl7-server).
 */
function startMllpListener({
  fhirAdapter,
  inbox,
  hospitalID,
  port,
  version = '2.5',
  log = console,
  onMessage = () => {},
  fieldMap,
  tls,
  allowedIps = [],
  bindAddress,
}) {
  const serverOptions = {};
  if (bindAddress) serverOptions.bindAddress = bindAddress;
  if (tls) {
    serverOptions.tls = { cert: tls.cert, key: tls.key, ca: tls.ca, requestCert: Boolean(tls.ca) };
  }
  const server = new Server(serverOptions);
  // node-hl7-server's `name` option rejects most punctuation (it's meant
  // for log-friendly labels, not arbitrary strings) -- hospitalID may
  // contain hyphens (e.g. "hospital-a"), so sanitize rather than pass it
  // through raw.
  const listenerName = `hl7_adt_${hospitalID.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const allow = new Set(allowedIps.map(normalizeIp));

  const inbound = server.createInbound({ port, version, name: listenerName }, async (req, res) => {
    const message = req.getMessage();
    if (inbox) {
      const outcome = inbox.receive(hospitalID, message.toString());
      if (outcome.ack === 'AA') {
        log.log(`[hl7AdtListener] ${hospitalID}: ${outcome.duplicate ? 'duplicate' : outcome.status} message ${outcome.id}`);
      } else {
        log.warn(`[hl7AdtListener] ${hospitalID}: answering ${outcome.ack} -- ${outcome.reason}`);
      }
      await res.sendResponse(outcome.ack);
      return;
    }

    const result = ingestParsedMessage(fhirAdapter, hospitalID, message, { log, fieldMap });
    try {
      onMessage(result);
    } catch (err) {
      log.warn(`[hl7AdtListener] status callback failed: ${err.message}`);
    }
    if (result.ok) {
      log.log(`[hl7AdtListener] ${hospitalID}: ingested ADT^${result.triggerEvent} (control ID ${result.controlId || 'none'})`);
      await res.sendResponse('AA');
    } else {
      log.warn(`[hl7AdtListener] ${hospitalID}: rejecting message -- ${result.reason}`);
      await res.sendResponse('AE');
    }
  });

  if (allow.size) {
    inbound.on('client.connect', (socket) => {
      const remote = normalizeIp(socket.remoteAddress);
      if (!allow.has(remote)) {
        log.warn(`[hl7AdtListener] ${hospitalID}: refused MLLP connection from ${remote} (not in allowlist)`);
        socket.destroy();
      }
    });
  }
  inbound.on('listen', () => log.log(`[hl7AdtListener] ${hospitalID}: MLLP${tls ? '/TLS' : ''} listener on port ${port}`));
  inbound.on('error', (err) => log.warn(`[hl7AdtListener] ${hospitalID}: MLLP listener error: ${err.message}`));
  return inbound;
}

module.exports = {
  DEFAULT_FIELD_MAP,
  resolveFieldMap,
  hl7DateToIso,
  hl7SexToFhirGender,
  hl7PatientClassToFhirClass,
  parseHl7Message,
  mapAdtMessageToResources,
  ingestParsedMessage,
  ingestRawAdtText,
  startMllpListener,
};
