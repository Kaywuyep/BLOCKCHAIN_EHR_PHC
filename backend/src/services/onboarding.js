'use strict';

const { randomUUID } = require('crypto');
const { ROLES } = require('../auth/auth');
const { AccountError } = require('./accountStore');
const { fetchPractitioner, searchPractitioners } = require('./liveFhirClient');
const smartClinic = require('./smartClinicClient');

/** Staff lookup in the hospital's own EMR, whichever kind it is. `hints` (email, name) speed up SmartClinic. */
function fetchFromEmr(hospital, staffID, { hints = [] } = {}) {
  if (hospital.integration === 'smartclinic') return smartClinic.fetchStaff(hospital, staffID, { hints });
  return fetchPractitioner(hospital, staffID);
}

/**
 * onboarding.js
 *
 * Creating people and hospitals in AUTH_MODE=password, with each one
 * recorded on the ledger (an audit entry) before it is saved here:
 *
 *   ACCOUNT_CREATED       a patient signs up, or a hospital admin / clinician /
 *                         system admin account is created. actorID is the new
 *                         account's opaque subject; no name or email goes on-chain.
 *   HOSPITAL_REGISTERED   a system admin adds a hospital.
 *   CLINICIAN_STATUS_CHANGED
 *                         a clinician's status changed after a re-sync with the
 *                         hospital's EMR (or a local suspension).
 *
 * A patient's Health ID (DID) is still minted later, when they confirm
 * their record at their first hospital (Chapter 3, FR1).
 *
 * The ledger write happens first: if the ledger is unreachable, nothing is
 * created and the caller gets an error, so nothing exists off-chain that
 * the ledger has not seen.
 */

// Staff IDs as the hospital writes them; "/" is common (e.g. JUTH/0042).
const STAFF_ID_PATTERN = /^[A-Za-z0-9._/-]{1,64}$/;

/** A clinician's username: <staff ID>@<hospital ID>, lower-case, "/" written as "-". */
function staffLogin(staffID, hospitalID) {
  return `${String(staffID).replace(/\//g, '-')}@${hospitalID}`.toLowerCase();
}

function fail(message, status = 400) {
  throw new AccountError(message, status);
}

class Onboarding {
  constructor({ accounts, users, hospitals, providers, ledgerPromise, logger = null, fetchStaff = fetchFromEmr }) {
    this.accounts = accounts;
    this.users = users;
    this.hospitals = hospitals;
    this.providers = providers;
    this.ledgerPromise = ledgerPromise;
    this.logger = logger;
    this.fetchStaff = fetchStaff;
  }

  async onChain(eventType, { actorID, hospitalID = '', detail = {} }) {
    const ledger = await this.ledgerPromise;
    try {
      await ledger.writeAuditEntry({
        entryID: randomUUID(),
        patientDID: '',
        eventType,
        actorID,
        hospitalID: hospitalID || '',
        detail: JSON.stringify(detail),
        clientTimestamp: new Date().toISOString(),
        queuedOffline: false,
      });
    } catch (err) {
      if (this.logger) this.logger.error('ledger write failed during onboarding', { eventType, err });
      fail('the blockchain did not accept this change, so nothing was saved. Try again in a minute.', 503);
    }
  }

  // ── Patients ─────────────────────────────────────────────────────────

  async signUpPatient(input) {
    const clean = this.accounts.checkPatientSignUp(input);
    const subject = `pt-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await this.onChain('ACCOUNT_CREATED', { actorID: subject, detail: { role: ROLES.PATIENT, via: 'self-signup' } });
    this.accounts.createPatient({ subject, ...clean });
    return { subject, login: clean.login };
  }

  // ── Hospitals ────────────────────────────────────────────────────────

  /** Creates a hospital and its first hospital admin, with a temporary password. */
  async createHospital(input, { createdBy }) {
    const clean = this.hospitals.checkNew(input);
    const hospitalID = clean.hospitalID;
    const adminLogin = `admin@${hospitalID}`;
    const adminSubject = adminLogin;
    if (this.users.getAccount(adminSubject) || this.accounts.loginTaken(adminLogin)) {
      fail(`the username "${adminLogin}" is already taken`, 409);
    }
    const adminName = String((input.adminUser && input.adminUser.displayName) || '').trim() || `${clean.name} admin`;

    await this.onChain('HOSPITAL_REGISTERED', { actorID: createdBy, hospitalID, detail: { name: clean.name, integration: clean.integration } });
    await this.onChain('ACCOUNT_CREATED', { actorID: adminSubject, hospitalID, detail: { role: ROLES.HOSPITAL_ADMIN, by: createdBy } });

    const hospital = this.hospitals.create(input, { createdBy });
    this.users.create({ subject: adminSubject, displayName: adminName, roles: [ROLES.HOSPITAL_ADMIN], hospitalID }, { createdBy });
    const credentials = this.accounts.issueTemporary(adminSubject, adminLogin);
    return { hospital, adminAccount: { ...credentials, displayName: adminName } };
  }

  // ── Clinicians ───────────────────────────────────────────────────────

  _hospitalForStaff(hospitalID) {
    const hospital = this.hospitals.getInternal(hospitalID);
    if (!hospital) fail(`unknown hospital "${hospitalID}"`, 404);
    if (hospital.status !== 'active') fail('this hospital is inactive');
    return hospital;
  }

  static hasEmr(hospital) {
    if (!hospital) return false;
    if (hospital.integration === 'smartclinic') return Boolean(hospital.smartclinic && hospital.smartclinic.baseUrl);
    return Boolean(hospital.fhir && hospital.fhir.baseUrl && ['fhir', 'both'].includes(hospital.integration));
  }

  /**
   * Search the hospital's EMR by staff ID or name (nothing is saved).
   * Each result says whether that person is already registered here.
   */
  async searchEmr(hospitalID, query) {
    query = String(query || '').trim();
    if (query.length < 2 || query.length > 80) fail('type at least 2 characters of a staff ID or name');
    const hospital = this._hospitalForStaff(hospitalID);
    if (!Onboarding.hasEmr(hospital)) fail('this hospital has no connection to its EMR (FHIR or SmartClinic); ask the system admin to set one up');
    let found;
    try {
      found = hospital.integration === 'smartclinic'
        ? await smartClinic.searchStaff(hospital, query)
        : await searchPractitioners(hospital, query);
    } catch (err) {
      fail(`EMR search failed: ${err.message}`, 502);
    }
    return {
      total: found.total,
      results: found.results.map((r) => ({
        ...r,
        usable: Boolean(r.staffID && STAFF_ID_PATTERN.test(r.staffID)),
        alreadyRegistered: Boolean(r.staffID && this.providers.get(r.staffID, hospitalID)),
      })),
    };
  }

  /** Looks a staff ID up in the hospital's EMR without saving anything. */
  async previewFromEmr(hospitalID, staffID, { hint } = {}) {
    staffID = String(staffID || '').trim();
    if (!STAFF_ID_PATTERN.test(staffID)) fail('staff ID may contain letters, digits and . _ - / (max 64)');
    const hospital = this._hospitalForStaff(hospitalID);
    if (!Onboarding.hasEmr(hospital)) fail('this hospital has no connection to its EMR (FHIR or SmartClinic); ask the system admin to set one up');
    try {
      return await this.fetchStaff(hospital, staffID, { hints: hint ? [String(hint).trim().slice(0, 120)] : [] });
    } catch (err) {
      fail(`EMR lookup failed: ${err.message}`, 502);
    }
    return null;
  }

  /**
   * Adds a clinician from the hospital's EMR, by staff ID, and gives them a
   * login (<staffID>@<hospitalID>) with a temporary password. The EMR's
   * name, role, department and active flag are copied as-is.
   */
  async enrollFromEmr(hospitalID, staffID, { createdBy, hint }) {
    const emr = await this.previewFromEmr(hospitalID, staffID, { hint });
    if (!emr.active) fail(`the EMR shows ${emr.name || staffID} as not active, so they cannot be added`);
    return this._enroll(hospitalID, emr.staffID, {
      email: emr.email || null,
      name: emr.name || emr.staffID,
      role: emr.role || 'Physician',
      department: emr.department || 'General',
      status: 'ACTIVE',
      source: 'emr',
      emrSyncedAt: new Date().toISOString(),
    }, { createdBy });
  }

  /** For hospitals without an EMR connection: the hospital admin types the details. */
  async enrollManually(hospitalID, { providerID, name, role, department }, { createdBy }) {
    const hospital = this._hospitalForStaff(hospitalID);
    if (Onboarding.hasEmr(hospital)) fail("this hospital is connected to its EMR: add clinicians from the EMR by staff ID");
    providerID = String(providerID || '').trim();
    if (!STAFF_ID_PATTERN.test(providerID)) fail('staff ID may contain letters, digits and . _ - / (max 64)');
    if (!String(name || '').trim()) fail('name is required');
    return this._enroll(hospitalID, providerID, { name, role, department, status: 'ACTIVE', source: 'manual' }, { createdBy });
  }

  async _enroll(hospitalID, staffID, details, { createdBy }) {
    // The account ID (on-chain) is derived from the staff/record ID; the
    // username they type is their email when the EMR has one.
    const subject = staffLogin(staffID, hospitalID);
    const login = details.email || subject;
    if (this.users.getAccount(subject)) {
      fail(`${details.name || staffID} already has an account here; use Re-sync or Reset password instead`, 409);
    }
    if (this.accounts.loginTaken(login)) {
      fail(`the username ${login} is already used by another Cevruni account`, 409);
    }
    await this.onChain('ACCOUNT_CREATED', {
      actorID: subject,
      hospitalID,
      detail: { role: ROLES.CLINICIAN, providerID: staffID, source: details.source, by: createdBy },
    });
    const provider = this.providers.register({ providerID: staffID, hospitalID, ...details });
    this.users.create(
      { subject, displayName: provider.name, roles: [ROLES.CLINICIAN], hospitalID, providerID: staffID },
      { createdBy }
    );
    const credentials = this.accounts.issueTemporary(subject, login);
    return { provider, account: credentials };
  }

  /**
   * Re-reads a clinician from the EMR and applies what it says, including
   * deactivation. A clinician missing from the EMR becomes INACTIVE.
   */
  async resyncFromEmr(hospitalID, providerID, { by }) {
    const existing = this.providers.get(providerID, hospitalID);
    if (!existing) fail('clinician not registered at this hospital', 404);
    const hospital = this._hospitalForStaff(hospitalID);
    if (!Onboarding.hasEmr(hospital)) fail('this hospital has no connection to its EMR');
    let emr;
    try {
      emr = await this.fetchStaff(hospital, providerID, { hints: [existing.email, existing.name].filter(Boolean) });
    } catch (err) {
      if (!/no staff member/.test(err.message)) fail(`EMR lookup failed: ${err.message}`, 502);
      emr = null;
    }
    // A local suspension stands until the hospital admin lifts it; the EMR
    // can deactivate but never re-activate over it.
    const emrStatus = emr && emr.active ? 'ACTIVE' : 'INACTIVE';
    const status = existing.status === 'SUSPENDED' && emrStatus === 'ACTIVE' ? 'SUSPENDED' : emrStatus;
    if (status !== existing.status) {
      await this.onChain('CLINICIAN_STATUS_CHANGED', {
        actorID: by,
        hospitalID,
        detail: { providerID, from: existing.status, to: status, reason: emr ? 'emr' : 'not-in-emr' },
      });
    }
    const provider = this.providers.register({
      ...existing,
      name: (emr && emr.name) || existing.name,
      role: (emr && emr.role) || existing.role,
      department: (emr && emr.department) || existing.department,
      status,
      source: 'emr',
      emrSyncedAt: new Date().toISOString(),
      email: (emr && emr.email) || existing.email,
    });
    return { provider, inEmr: Boolean(emr) };
  }

  /** Local status change by the hospital admin. EMR clinicians can be suspended, not activated against the EMR. */
  async setClinicianStatus(hospitalID, providerID, status, { by }) {
    const existing = this.providers.get(providerID, hospitalID);
    if (!existing) fail('clinician not registered at this hospital', 404);
    status = String(status || '').toUpperCase();
    if (!['ACTIVE', 'SUSPENDED', 'INACTIVE'].includes(status)) fail('status must be ACTIVE, SUSPENDED or INACTIVE');
    if (status === existing.status) return existing;
    if (status === 'ACTIVE' && existing.source === 'emr' && existing.status === 'INACTIVE') {
      fail('the EMR shows this clinician as not active; use Re-sync once the EMR is updated');
    }
    await this.onChain('CLINICIAN_STATUS_CHANGED', {
      actorID: by,
      hospitalID,
      detail: { providerID, from: existing.status, to: status, reason: 'hospital-admin' },
    });
    return this.providers.register({ ...existing, status });
  }

  // ── System admin ─────────────────────────────────────────────────────

  /**
   * First start in password mode: create the system admin account
   * "superadmin" with a temporary password, returned to be logged once.
   */
  async bootstrapSystemAdmin() {
    if (this.accounts.systemAdminCount() > 0) return null;
    const subject = 'superadmin';
    await this.onChain('ACCOUNT_CREATED', { actorID: subject, detail: { role: ROLES.SYSTEM_ADMIN, via: 'first-start' } });
    if (!this.users.getAccount(subject)) {
      this.users.create({ subject, displayName: 'System administrator', roles: [ROLES.SYSTEM_ADMIN] }, { createdBy: 'first-start' });
    } else {
      this.users.update(subject, { roles: [ROLES.SYSTEM_ADMIN], hospitalID: null });
    }
    return this.accounts.issueTemporary(subject, subject);
  }
}

module.exports = { Onboarding, STAFF_ID_PATTERN, staffLogin };
