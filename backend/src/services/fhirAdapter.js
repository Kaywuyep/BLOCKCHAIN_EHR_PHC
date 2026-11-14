'use strict';

const { randomUUID } = require('crypto');
const { openDatabase } = require('../db/database');
const { FieldCipher } = require('../db/fieldCipher');


/**
 * fhirAdapter.js
 *
 * Simulates each hospital's own EMR/database plus the per-facility FHIR
 * Adapter described in Section 3.5.1 and Figure 4. This is deliberately
 * NOT part of the blockchain: it represents "Hospital A EMR/Database
 * (unchanged)" and "Hospital B EMR/Database (unchanged)" from Figure 1.
 *
 * The DID -> local MRN mapping below is held only in this module's
 * own off-chain store (an encrypted SQLite database, see db/database.js),
 * exactly as the paper specifies it must be: never written on-chain,
 * never replicated to another facility. Swap this for
 * a real hospital's patient index + FHIR server in production; the
 * contract with the rest of the system (resolveRecord's inputs/outputs)
 * stays the same.
 */
class FhirAdapter {
  /**
   * @param {{ db?: import('better-sqlite3').Database, cipher?: FieldCipher }} [options]
   *   Without options the adapter uses a private in-memory database with a
   *   throwaway key (tests, the simulated demo). server.js passes the
   *   durable, encrypted store.
   */
  constructor({ db, cipher } = {}) {
    this.db = db || openDatabase(':memory:');
    this.cipher = cipher || FieldCipher.ephemeral();
    // Tables (see db/database.js):
    //   local_patient_index  hospital roster: hospitalNumber -> encrypted { name, dob, ... }
    //   did_links            DID -> hospital number (Section 3.5.1), never on-chain
    //   clinical_bundles     encrypted FHIR bundles, keyed by hospital number
    const q = (sql) => this.db.prepare(sql);
    this.sql = {
      upsertLocal: q(`INSERT INTO local_patient_index (hospital_id, hospital_number, data_enc, updated_at)
                      VALUES (?, ?, ?, ?)
                      ON CONFLICT (hospital_id, hospital_number) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at`),
      getLocal: q('SELECT data_enc FROM local_patient_index WHERE hospital_id = ? AND hospital_number = ?'),
      listLocal: q('SELECT hospital_number, data_enc FROM local_patient_index WHERE hospital_id = ? ORDER BY hospital_number'),
      upsertLink: q(`INSERT INTO did_links (hospital_id, patient_did, hospital_number, linked_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT (hospital_id, patient_did) DO UPDATE SET hospital_number = excluded.hospital_number, linked_at = excluded.linked_at`),
      getLink: q('SELECT hospital_number FROM did_links WHERE hospital_id = ? AND patient_did = ?'),
      linksForPatient: q('SELECT hospital_id, hospital_number, linked_at FROM did_links WHERE patient_did = ? ORDER BY linked_at'),
      linksForHospital: q('SELECT patient_did, hospital_number, linked_at FROM did_links WHERE hospital_id = ? ORDER BY linked_at DESC'),
      getDidByHospitalNumber: q('SELECT patient_did FROM did_links WHERE hospital_id = ? AND hospital_number = ?'),
      insertBundle: q('INSERT INTO clinical_bundles (id, hospital_id, hospital_number, bundle_enc, created_at) VALUES (?, ?, ?, ?, ?)'),
      listBundles: q(`SELECT bundle_enc FROM clinical_bundles WHERE hospital_id = ? AND hospital_number = ?
                      ORDER BY created_at, rowid`),
    };
  }

  /** Adds (or updates) an entry in a hospital's own patient roster, keyed
   *  by the hospital's own number -- simulating a record the hospital's
   *  legacy EMR already has, before PatientChain existed. `name` and `dob`
   *  are required; any further fields (e.g. `sex`, or a `sourceResource`
   *  carrying the full FHIR Patient resource an ingestion path built) are
   *  stored alongside but not required. The record is encrypted at rest. */
  addLocalPatientRecord(hospitalID, hospitalNumber, { name, dob, ...rest }) {
    const record = { name, dob, ...rest };
    this.sql.upsertLocal.run(hospitalID, hospitalNumber, this.cipher.encryptJson(record), new Date().toISOString());
    return { hospitalNumber, ...record };
  }

  /** Looks up a hospital's own roster by hospital number alone -- no DID
   *  required. This is the "does this hospital number exist, and does it
   *  belong to someone with this date of birth" check the patient-asserted
   *  linkage flow needs before it will show a patient any name back. */
  findLocalPatientRecord(hospitalID, hospitalNumber) {
    const row = this.sql.getLocal.get(hospitalID, hospitalNumber);
    return row ? this.cipher.decryptJson(row.data_enc) : null;
  }

  /** Lists everything in a hospital's own roster -- for the hospital's own
   *  admin view of the records patients can link against. Never exposes
   *  which of them are already linked to a DID. */
  listLocalPatientRecords(hospitalID) {
    return this.sql.listLocal.all(hospitalID).map((row) => ({
      hospitalNumber: row.hospital_number,
      ...this.cipher.decryptJson(row.data_enc),
    }));
  }

  /** The hospitals a DID is linked at (the patient's "My Hospitals"). */
  listLinksForPatient(patientDID) {
    return this.sql.linksForPatient.all(patientDID).map((r) => ({ hospitalID: r.hospital_id, hospitalNumber: r.hospital_number, linkedAt: r.linked_at }));
  }

  /** Every DID linked at a hospital, with its hospital number (hospital admin view). */
  listLinks(hospitalID) {
    return this.sql.linksForHospital.all(hospitalID).map((r) => ({ patientDID: r.patient_did, hospitalNumber: r.hospital_number, linkedAt: r.linked_at }));
  }

  /** Reverse lookup: given a hospital number, find the patient DID. */
  findDidByHospitalNumber(hospitalID, hospitalNumber) {
    const row = this.sql.getDidByHospitalNumber.get(hospitalID, hospitalNumber);
    return row ? row.patient_did : null;
  }

  /** Links a DID to a hospital number (or a freshly minted MRN). */
  registerLocalPatient(hospitalID, patientDID, mrn) {
    const hospitalNumber = mrn || `MRN-${randomUUID().slice(0, 8).toUpperCase()}`;
    this.sql.upsertLink.run(hospitalID, patientDID, hospitalNumber, new Date().toISOString());
    return hospitalNumber;
  }

  /** Wraps a single already-FHIR-shaped resource in a Bundle and appends it
   *  to a hospital's database, keyed directly by hospital number. Shared by
   *  createClinicalRecord (below, which resolves a DID to a number first)
   *  and recordResourceByHospitalNumber (which doesn't need a DID at all). */
  _storeBundleEntry(hospitalID, hospitalNumber, resource, related = []) {
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      entry: [{ resource }, ...related.map((r) => ({ resource: r }))],
    };
    this.sql.insertBundle.run(bundle.id, hospitalID, hospitalNumber, this.cipher.encryptJson(bundle), bundle.timestamp);
    // Point-of-care hook (FR3): the Reference Service registers an on-chain
    // pointer for this record if the patient has linked a DID here.
    if (this.onRecordStored) {
      try {
        this.onRecordStored(hospitalID, hospitalNumber, bundle);
      } catch {
        // the record is stored; pointer registration retries at link time
      }
    }
    return bundle;
  }

  /** All stored bundles for one hospital number (Reference Service use). */
  listBundlesByHospitalNumber(hospitalID, hospitalNumber) {
    return this.sql.listBundles.all(hospitalID, hospitalNumber).map((row) => this.cipher.decryptJson(row.bundle_enc));
  }

  /** Hospital creates a clinical record locally (Figure 3, step 1). */
  createClinicalRecord(hospitalID, patientDID, record) {
    const link = this.sql.getLink.get(hospitalID, patientDID);
    if (!link) throw new Error(`patient ${patientDID} has no local record at hospital ${hospitalID}`);
    return this._storeBundleEntry(hospitalID, link.hospital_number, {
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
   * PatientChain DID to that hospital number. If/when a DID later links to
   * this hospitalNumber, resolveRecord finds these entries automatically.
   */
  recordResourceByHospitalNumber(hospitalID, hospitalNumber, resource, related = []) {
    return this._storeBundleEntry(hospitalID, hospitalNumber, resource, related);
  }

  /**
   * resolveRecord mirrors Figure 4 exactly:
   *  1. caller has already had the grant validated on-chain (by the route handler)
   *  2. resolve DID -> local MRN (never leaves this module)
   *  3. query the hospital's own "database"
   *  4. return the FHIR bundle -- it never touches the blockchain
   */
  resolveRecord(hospitalID, patientDID) {
    const link = this.sql.getLink.get(hospitalID, patientDID);
    if (!link) {
      throw new Error(`no local patient index entry for ${patientDID} at ${hospitalID}`);
    }
    const bundles = this.sql.listBundles.all(hospitalID, link.hospital_number).map((row) => this.cipher.decryptJson(row.bundle_enc));
    return { mrn: link.hospital_number, bundles };
  }
}

// No singleton: server.js builds one FhirAdapter on the durable store, and
// tests build their own in-memory instances.
module.exports = { FhirAdapter };
