'use strict';

/**
 * referenceService.js — the hospital's Reference Service (FR3).
 *
 * Registers an on-chain pointer (hospital ID, record type, date — never
 * clinical content) for each clinical record, at the point of care:
 *
 *   - when a new record is stored for a hospital number that a patient has
 *     already linked to their DID (HL7 ADT feed, REST ingestion, FHIR push);
 *   - when a patient links a hospital, for the records that hospital
 *     already held for them.
 *
 * One pointer per stored record (bundle). The pointer ID is derived from
 * the bundle ID, so registering the same record twice is a no-op.
 */

const CLINICAL = new Set(['Encounter', 'Observation', 'DiagnosticReport', 'Condition', 'MedicationRequest', 'DocumentReference', 'AllergyIntolerance']);

function recordDate(resource, fallback) {
  return (
    resource.effectiveDateTime ||
    resource.issued ||
    resource.authoredOn ||
    resource.recordedDate ||
    resource.date ||
    (resource.period && resource.period.start) ||
    fallback
  );
}

class ReferenceService {
  constructor({ ledgerPromise, fhirAdapter, logger = null }) {
    this.ledgerPromise = ledgerPromise;
    this.fhirAdapter = fhirAdapter;
    this.logger = logger;
    this.pending = new Set();
  }

  /** Pointer for one stored bundle, if its hospital number is linked to a DID. */
  async registerForBundle(hospitalID, hospitalNumber, bundle, patientDID = null) {
    const did = patientDID || this.fhirAdapter.findDidByHospitalNumber(hospitalID, hospitalNumber);
    if (!did) return null;
    const main = (bundle.entry || []).map((e) => e.resource).find((r) => r && CLINICAL.has(r.resourceType));
    if (!main) return null;
    const refID = `ref-${bundle.id}`;
    if (this.pending.has(refID)) return null;
    this.pending.add(refID);
    try {
      const ledger = await this.ledgerPromise;
      return await ledger.registerRecordReference({
        refID,
        patientDID: did,
        hospitalID,
        recordType: main.resourceType,
        date: new Date(recordDate(main, bundle.timestamp)).toISOString(),
        registeredBy: `reference-service@${hospitalID}`,
      });
    } catch (err) {
      // "already exists": registered before; "not registered": the patient's
      // DID is not on this ledger yet (registerExisting covers it later).
      if (!/already exists|not registered/.test(err.message) && this.logger) {
        this.logger.warn('record pointer registration failed', { hospitalID, err });
      }
      return null;
    } finally {
      this.pending.delete(refID);
    }
  }

  /** Pointers for everything a hospital already holds for a newly linked patient. */
  async registerExisting(hospitalID, patientDID, hospitalNumber) {
    const bundles = this.fhirAdapter.listBundlesByHospitalNumber(hospitalID, hospitalNumber);
    const out = [];
    for (const b of bundles) {
      const ref = await this.registerForBundle(hospitalID, hospitalNumber, b, patientDID);
      if (ref) out.push(ref);
    }
    return out;
  }

  /** Wires the point-of-care hook into the FHIR adapter. */
  attach() {
    this.fhirAdapter.onRecordStored = (hospitalID, hospitalNumber, bundle) => {
      this.registerForBundle(hospitalID, hospitalNumber, bundle);
    };
    return this;
  }
}

module.exports = { ReferenceService };
