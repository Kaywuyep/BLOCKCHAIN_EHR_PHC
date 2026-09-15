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
  }

  _ensureHospital(hospitalID) {
    if (!this.didToMrn.has(hospitalID)) this.didToMrn.set(hospitalID, new Map());
    if (!this.database.has(hospitalID)) this.database.set(hospitalID, new Map());
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

  /** Hospital creates a clinical record locally (Figure 3, step 1). */
  createClinicalRecord(hospitalID, patientDID, record) {
    this._ensureHospital(hospitalID);
    const mrn = this.didToMrn.get(hospitalID).get(patientDID);
    if (!mrn) throw new Error(`patient ${patientDID} has no local record at hospital ${hospitalID}`);
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      entry: [
        {
          resource: {
            resourceType: record.recordType === 'lab' ? 'Observation' : 'Encounter',
            id: randomUUID(),
            status: 'final',
            ...record.fhirFields,
          },
        },
      ],
    };
    this.database.get(hospitalID).get(mrn).push(bundle);
    return bundle;
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

// Singleton + demo seed data so the app has something to show immediately.
const fhirAdapter = new FhirAdapter();

function seedDemoData() {
  fhirAdapter.registerLocalPatient('HospitalA-Lagos', 'did:patientchain:demo-patient-1', 'LAG-00231');
  fhirAdapter.createClinicalRecord('HospitalA-Lagos', 'did:patientchain:demo-patient-1', {
    recordType: 'encounter',
    fhirFields: { class: 'AMB', reasonCode: [{ text: 'Routine antenatal visit' }] },
  });
  fhirAdapter.createClinicalRecord('HospitalA-Lagos', 'did:patientchain:demo-patient-1', {
    recordType: 'lab',
    fhirFields: { code: { text: 'Full Blood Count' }, valueString: 'Within normal limits' },
  });

  fhirAdapter.registerLocalPatient('HospitalB-Ibadan', 'did:patientchain:demo-patient-1', 'IBD-77410');
}

module.exports = { fhirAdapter, seedDemoData };
