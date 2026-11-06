'use strict';

/**
 * linkageService.js
 *
 * Replaces the old Master Patient Index / probabilistic-matching design
 * (NIN deterministic match + weighted demographic scoring + a manual
 * "possible duplicate" review queue) with a simpler, patient-asserted
 * linkage flow: the patient already knows which hospital they have a
 * record at, so they assert their hospital number and date of birth for
 * that hospital, and the system either confirms it or doesn't. There is
 * no fuzzy scoring and nothing is ever auto-merged.
 *
 * This never writes to the ledger, and it never invents a new data store
 * for hospital demographics -- it looks records up via fhirAdapter's own
 * local patient index (fhirAdapter.js), and the eventual DID <->
 * hospital-number link is written into that same module's existing
 * didToMrn mapping via registerLocalPatient(). Nothing here is ever
 * written on-chain.
 */
class LinkageService {
  /**
   * @param {import('./fhirAdapter').FhirAdapter} fhirAdapter
   * @param {{ maxAttempts?: number, attemptWindowMs?: number }} [options]
   */
  constructor(fhirAdapter, options = {}) {
    this.fhirAdapter = fhirAdapter;
    this.maxAttempts = options.maxAttempts || 5;
    this.attemptWindowMs = options.attemptWindowMs || 15 * 60 * 1000;

    // patientDID -> { count, windowStart } -- a second layer against
    // hospital-number enumeration, on top of the generic error message
    // below. Per-patient-session, not per-hospital, so a caller can't
    // dodge the limit by rotating which hospital they probe.
    this.lookupAttempts = new Map();

    // `${patientDID}::${hospitalID}` -> hospitalNumber that a lookup just
    // confirmed a name for. confirmLink() only ever commits a link that
    // has a matching pending entry here -- it can't be called directly
    // to skip verification.
    this.pendingLinks = new Map();
  }

  static normalize(value) {
    return (value || '').toString().trim().toLowerCase();
  }

  _checkRateLimit(patientDID) {
    const now = Date.now();
    const entry = this.lookupAttempts.get(patientDID);
    if (!entry || now - entry.windowStart > this.attemptWindowMs) {
      this.lookupAttempts.set(patientDID, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
    if (entry.count > this.maxAttempts) {
      throw new Error('too many lookup attempts -- please try again later');
    }
  }

  /**
   * Step 1: the patient asserts a hospital number and date of birth for a
   * given hospital. Whether the hospital number doesn't exist at all, or
   * exists but the date of birth doesn't match, this throws the exact
   * same generic error -- distinguishing the two would let a caller
   * enumerate valid hospital numbers and harvest the names behind them.
   * On a match, it returns the record's name for the patient to confirm,
   * but does not link anything yet.
   */
  linkFacility(patientDID, hospitalID, hospitalNumber, dateOfBirth) {
    if (!patientDID || !hospitalID || !hospitalNumber || !dateOfBirth) {
      throw new Error('patientDID, hospitalID, hospitalNumber and dateOfBirth are all required');
    }

    this._checkRateLimit(patientDID);

    const record = this.fhirAdapter.findLocalPatientRecord(hospitalID, hospitalNumber);
    const matches = Boolean(record) && LinkageService.normalize(record.dob) === LinkageService.normalize(dateOfBirth);
    if (!matches) {
      throw new Error('No matching record found');
    }

    this.pendingLinks.set(`${patientDID}::${hospitalID}`, hospitalNumber);
    return { name: record.name };
  }

  /**
   * Step 2: only ever called after the patient has seen the matched name
   * from linkFacility() and explicitly confirmed "yes, this is me". Records
   * the DID <-> hospital-number mapping in fhirAdapter's existing local
   * index -- never on-chain, and never a new store of its own.
   */
  confirmLink(patientDID, hospitalID, hospitalNumber) {
    if (!patientDID || !hospitalID || !hospitalNumber) {
      throw new Error('patientDID, hospitalID and hospitalNumber are all required');
    }

    const key = `${patientDID}::${hospitalID}`;
    if (this.pendingLinks.get(key) !== hospitalNumber) {
      throw new Error('no confirmed match pending for that hospital number -- look it up again first');
    }
    this.pendingLinks.delete(key);

    const linkedHospitalNumber = this.fhirAdapter.registerLocalPatient(hospitalID, patientDID, hospitalNumber);
    return { patientDID, hospitalID, hospitalNumber: linkedHospitalNumber };
  }
}

module.exports = { LinkageService };
