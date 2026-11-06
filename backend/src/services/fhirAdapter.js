'use strict';

const { randomUUID } = require('crypto');

/**
 * fhirAdapter.js
 *
 * Simulates each hospital's own EMR/database plus the per-facility FHIR
 * Adapter described in Section 3.5.1 and Figure 4. This is deliberately
 * NOT part of the blockchain: it represents "Hospital A EMR/Database
 * (unchanged)" and "Hospital B EMR/Database (unchanged)" from Figure 1.
 *
 * The DID -> local MRN mapping below is held only in this module's
 * in-memory store, exactly as the paper specifies it must be: never
 * written on-chain, never replicated to another facility. Swap this for
 * a real hospital's patient index + FHIR server in production; the
 * contract with the rest of the system (resolveRecord's inputs/outputs)
 * stays the same.
 */
class FhirAdapter {
  constructor() {
    // hospitalID -> Map(patientDID -> MRN)      (local mapping, Section 3.5.1)
    this.didToMrn = new Map();
    // hospitalID -> Map(MRN -> [FHIR R4 bundle-like records])
    this.database = new Map();
    // hospitalID -> Map(hospitalNumber -> { name, dob })
    //
    // A hospital's own pre-existing patient roster -- demographics it
    // already holds against a hospital number, independent of whether
    // that patient has ever linked a PatientChain DID to it. Used only by
    // the patient-asserted facility-linkage flow (linkageService.js) to
    // verify a lookup before any DID <-> hospitalNumber mapping is
    // written into didToMrn above. Same rule as didToMrn: never leaves
    // this module, never written on-chain.
    this.localPatientIndex = new Map();
  }

  _ensureHospital(hospitalID) {
    if (!this.didToMrn.has(hospitalID)) this.didToMrn.set(hospitalID, new Map());
    if (!this.database.has(hospitalID)) this.database.set(hospitalID, new Map());
    if (!this.localPatientIndex.has(hospitalID)) this.localPatientIndex.set(hospitalID, new Map());
  }

  /** Adds (or updates) an entry in a hospital's own patient roster, keyed
   *  by the hospital's own number -- simulating a record the hospital's
   *  legacy EMR already has, before PatientChain existed. `name` and `dob`
   *  are required; any further fields (e.g. `sex`, or a `sourceResource`
   *  carrying the full FHIR Patient resource an ingestion path built) are
   *  stored alongside but not required -- every existing caller that only
   *  ever passed `{ name, dob }` keeps working unchanged. */
  addLocalPatientRecord(hospitalID, hospitalNumber, { name, dob, ...rest }) {
    this._ensureHospital(hospitalID);
    const record = { name, dob, ...rest };
    this.localPatientIndex.get(hospitalID).set(hospitalNumber, record);
    return { hospitalNumber, ...record };
  }

  /** Looks up a hospital's own roster by hospital number alone -- no DID
   *  required. This is the "does this hospital number exist, and does it
   *  belong to someone with this date of birth" check the patient-asserted
   *  linkage flow needs before it will show a patient any name back. */
  findLocalPatientRecord(hospitalID, hospitalNumber) {
    this._ensureHospital(hospitalID);
    return this.localPatientIndex.get(hospitalID).get(hospitalNumber) || null;
  }

  /** Lists everything in a hospital's own roster -- for the hospital's own
   *  admin view of the records patients can link against. Never exposes
   *  which of them are already linked to a DID. */
  listLocalPatientRecords(hospitalID) {
    this._ensureHospital(hospitalID);
    return Array.from(this.localPatientIndex.get(hospitalID).entries()).map(([hospitalNumber, record]) => ({
      hospitalNumber,
      ...record,
    }));
  }

  /** Called once when a hospital first registers a patient locally. */
  registerLocalPatient(hospitalID, patientDID, mrn) {
    this._ensureHospital(hospitalID);
    this.didToMrn.get(hospitalID).set(patientDID, mrn || `MRN-${randomUUID().slice(0, 8).toUpperCase()}`);
    if (!this.database.get(hospitalID).has(this.didToMrn.get(hospitalID).get(patientDID))) {
      this.database.get(hospitalID).set(this.didToMrn.get(hospitalID).get(patientDID), []);
    }
    return this.didToMrn.get(hospitalID).get(patientDID);
  }

  /** Wraps a single already-FHIR-shaped resource in a Bundle and appends it
   *  to a hospital's database, keyed directly by hospital number. Shared by
   *  createClinicalRecord (below, which resolves a DID to a number first)
   *  and recordResourceByHospitalNumber (which doesn't need a DID at all). */
  _storeBundleEntry(hospitalID, hospitalNumber, resource) {
    this._ensureHospital(hospitalID);
    if (!this.database.get(hospitalID).has(hospitalNumber)) {
      this.database.get(hospitalID).set(hospitalNumber, []);
    }
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      entry: [{ resource }],
    };
    this.database.get(hospitalID).get(hospitalNumber).push(bundle);
    return bundle;
  }

  /** Hospital creates a clinical record locally (Figure 3, step 1). */
  createClinicalRecord(hospitalID, patientDID, record) {
    this._ensureHospital(hospitalID);
    const mrn = this.didToMrn.get(hospitalID).get(patientDID);
    if (!mrn) throw new Error(`patient ${patientDID} has no local record at hospital ${hospitalID}`);
    return this._storeBundleEntry(hospitalID, mrn, {
      resourceType: record.recordType === 'lab' ? 'Observation' : 'Encounter',
      id: randomUUID(),
      status: 'final',
      ...record.fhirFields,
    });
  }

  /**
   * Stores an already-FHIR-shaped resource (e.g. an Encounter built by
   * hl7AdtListener.js from a PV1 segment) keyed directly by hospital
   * number -- no DID required. Real-world clinical events arrive from a
   * hospital's ADT feed or EMR long before, if ever, a patient links a
   * PatientChain DID to that hospital number.
   *
   * This writes into the exact same `database` map createClinicalRecord
   * does. If/when a DID later links to this hospitalNumber
   * (registerLocalPatient / linkageService.confirmLink), resolveRecord
   * finds these entries automatically -- registerLocalPatient only
   * initializes an empty bundle array when none exists yet, so entries
   * written here first are preserved, not overwritten.
   */
  recordResourceByHospitalNumber(hospitalID, hospitalNumber, resource) {
    return this._storeBundleEntry(hospitalID, hospitalNumber, resource);
  }

  /**
   * resolveRecord mirrors Figure 4 exactly:
   *  1. caller has already had the grant validated on-chain (by the route handler)
   *  2. resolve DID -> local MRN (never leaves this module)
   *  3. query the hospital's own "database"
   *  4. return the FHIR bundle -- it never touches the blockchain
   */
  resolveRecord(hospitalID, patientDID) {
    this._ensureHospital(hospitalID);
    const mrn = this.didToMrn.get(hospitalID).get(patientDID);
    if (!mrn) {
      throw new Error(`no local patient index entry for ${patientDID} at ${hospitalID}`);
    }
    const bundles = this.database.get(hospitalID).get(mrn) || [];
    return { mrn, bundles };
  }
}

// Singleton -- starts completely empty. Hospitals populate their own local
// patient roster via POST /api/patients/local-records/:hospitalID (see
// routes/patients.js and the Admin Dashboard's "Hospital local patient
// roster" panel), the same way a real deployment would import from its
// actual EMR/FHIR server.
const fhirAdapter = new FhirAdapter();

module.exports = { FhirAdapter, fhirAdapter };
