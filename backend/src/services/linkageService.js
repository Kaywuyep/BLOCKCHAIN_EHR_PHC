'use strict';

/**
 * linkageService.js
 *
 * Replaces the old Master Patient Index / probabilistic-matching design
 * (NIN deterministic match + weighted demographic scoring + a manual
 * "possible duplicate" review queue) with a simpler, patient-asserted
 * linkage flow: the patient already knows which hospital they have a
 * record at, so they assert their hospital number and their name as
 * registered at that hospital (date of birth optional), and the system
 * either confirms it or doesn't. There is no fuzzy scoring and nothing is
 * ever auto-merged.
 *
 * Name match: every name the patient types must be on the record, and at
 * least two of them (or the record's only name), in any order, ignoring
 * case, punctuation and a missing middle name. "Amina Yusuf" matches the
 * record "YUSUF, Amina Bello". Date of birth is checked only when both the
 * patient and the record have one; many hospital records have none.
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
    // A confirmed match must be acted on soon: after this it expires, so a
    // match the patient answered "No" to cannot be confirmed later.
    this.pendingTtlMs = options.pendingTtlMs || 15 * 60 * 1000;

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

  /** True when this caller has used up their lookups for now (does not count as an attempt). */
  isRateLimited(patientDID) {
    const entry = this.lookupAttempts.get(patientDID);
    return Boolean(entry && Date.now() - entry.windowStart <= this.attemptWindowMs && entry.count >= this.maxAttempts);
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

  /** Name words, lower-case, without punctuation or titles. */
  static nameTokens(name) {
    const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'master', 'alhaji', 'alhaja', 'hajiya', 'mallam', 'malam', 'chief', 'prof', 'rev']);
    return String(name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .replace(/['-]/g, '')
      .split(/\s+/)
      .filter((t) => t && !TITLES.has(t));
  }

  static namesMatch(given, recordName) {
    const typed = [...new Set(LinkageService.nameTokens(given))];
    const record = new Set(LinkageService.nameTokens(recordName));
    if (!typed.length || !record.size) return false;
    if (typed.length < Math.min(2, record.size)) return false;
    return typed.every((t) => record.has(t));
  }

  /**
   * Step 1: the patient asserts a hospital number and their name as
   * registered there (and, optionally, date of birth). Whether the hospital
   * number doesn't exist, or exists but the name or date of birth doesn't
   * match, this throws the exact same generic error -- distinguishing them
   * would let a caller enumerate valid hospital numbers. On a match, it
   * returns the record's name for the patient to confirm, but does not
   * link anything yet.
   *
   * `details` is { name, dateOfBirth }; dateOfBirth may be omitted.
   */
  linkFacility(patientDID, hospitalID, hospitalNumber, details = {}) {
    const { name, dateOfBirth } = details || {};
    if (!patientDID || !hospitalID || !hospitalNumber || !String(name || '').trim()) {
      throw new Error('hospital, hospital number and name are all required');
    }

    this._checkRateLimit(patientDID);

    const record = this.fhirAdapter.findLocalPatientRecord(hospitalID, hospitalNumber);
    const dobChecked = Boolean(record && record.dob && dateOfBirth);
    const matches =
      Boolean(record) &&
      LinkageService.namesMatch(name, record.name) &&
      (!dobChecked || LinkageService.normalize(record.dob) === LinkageService.normalize(dateOfBirth));
    if (!matches) {
      throw new Error('No matching record found');
    }

    this.pendingLinks.set(`${patientDID}::${hospitalID}`, { hospitalNumber, at: Date.now() });
    return { name: record.name };
  }

  /**
   * Step 2: only ever called after the patient has seen the matched name
   * from linkFacility() and explicitly confirmed "yes, this is me". Records
   * the DID <-> hospital-number mapping in fhirAdapter's existing local
   * index -- never on-chain, and never a new store of its own.
   */
  /**
   * For first-time registration (FR1): the lookup was made before the
   * patient had a DID, under a provisional key. Consumes that pending
   * match; returns true if it was there.
   */
  /** The pending match for key if it is for hospitalNumber and not expired. */
  _pendingMatches(key, hospitalNumber) {
    const pending = this.pendingLinks.get(key);
    if (!pending) return false;
    if (Date.now() - pending.at > this.pendingTtlMs) {
      this.pendingLinks.delete(key);
      return false;
    }
    return pending.hospitalNumber === hospitalNumber;
  }

  consumePending(provisionalID, hospitalID, hospitalNumber) {
    const key = `${provisionalID}::${hospitalID}`;
    if (!this._pendingMatches(key, hospitalNumber)) return false;
    this.pendingLinks.delete(key);
    return true;
  }

  confirmLink(patientDID, hospitalID, hospitalNumber) {
    if (!patientDID || !hospitalID || !hospitalNumber) {
      throw new Error('patientDID, hospitalID and hospitalNumber are all required');
    }

    const key = `${patientDID}::${hospitalID}`;
    if (!this._pendingMatches(key, hospitalNumber)) {
      throw new Error('no confirmed match pending for that hospital number -- look it up again first');
    }
    this.pendingLinks.delete(key);

    const existing = this.fhirAdapter.findDidByHospitalNumber(hospitalID, hospitalNumber);
    if (existing && existing !== patientDID) {
      throw new Error('this hospital record is already linked to another Health ID -- ask the hospital to check it');
    }

    const linkedHospitalNumber = this.fhirAdapter.registerLocalPatient(hospitalID, patientDID, hospitalNumber);
    return { patientDID, hospitalID, hospitalNumber: linkedHospitalNumber };
  }
}

module.exports = { LinkageService };
