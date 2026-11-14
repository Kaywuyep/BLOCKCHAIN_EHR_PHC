'use strict';

const { ALL_ROLES, ROLES } = require('../auth/auth');

/**
 * userDirectory.js
 *
 * Every person (or system) that uses Cevruni, for the System Admin's
 * Users page. Rows come from three places:
 *
 *   seen     recorded automatically the first time an identity signs in,
 *            and refreshed (last seen, roles, hospital) on each sign-in;
 *   created  added by a system admin ahead of first sign-in, e.g. a new
 *            hospital's admin during hospital setup;
 *   plus, merged in at read time, clinicians in the provider registry and
 *   patients bound to a DID, who may not have a row yet.
 *
 * Identity itself stays with the identity provider (OIDC) or the local
 * development login: this directory never stores passwords. Disabling a
 * user here blocks their tokens at the API even if the IdP still issues
 * them.
 */

const SUBJECT_PATTERN = /^[\w.@:-]{1,128}$/;
const STAFF_ROLES = new Set([ROLES.CLINICIAN, ROLES.HOSPITAL_ADMIN, ROLES.HL7_INTERFACE]);
const TOUCH_INTERVAL_MS = 60_000;

class UserDirectory {
  constructor({ db }) {
    this.db = db;
    const q = (sql) => db.prepare(sql);
    this.sql = {
      get: q('SELECT * FROM users WHERE subject = ?'),
      all: q('SELECT * FROM users'),
      insert: q(`INSERT INTO users (subject, display_name, roles, hospital_id, provider_id, status, source, created_at, created_by, last_seen_at)
                 VALUES (@subject, @displayName, @roles, @hospitalID, @providerID, 'active', @source, @now, @createdBy, @lastSeenAt)`),
      seen: q(`UPDATE users SET roles = @roles, hospital_id = COALESCE(@hospitalID, hospital_id),
                 provider_id = COALESCE(@providerID, provider_id), last_seen_at = @now WHERE subject = @subject`),
      update: q(`UPDATE users SET display_name = @displayName, roles = @roles, hospital_id = @hospitalID,
                 provider_id = @providerID WHERE subject = @subject`),
      setStatus: q('UPDATE users SET status = ? WHERE subject = ?'),
      bindings: q('SELECT subject, patient_did, bound_at FROM identity_bindings'),
      providers: q('SELECT hospital_id, provider_id, data, status, registered_at FROM providers'),
    };
    this.lastTouch = new Map();
  }

  /** The stored row only (no registry merge), or null. */
  getAccount(subject) {
    const row = this.sql.get.get(subject);
    return row ? this._fromRow(row) : null;
  }

  isDisabled(subject) {
    const row = this.sql.get.get(subject);
    return Boolean(row && row.status === 'disabled');
  }

  /** Called on each authenticated request; writes at most once a minute per user. */
  recordSignIn(user) {
    if (!user || user.superuser || !user.sub) return;
    const now = Date.now();
    if (now - (this.lastTouch.get(user.sub) || 0) < TOUCH_INTERVAL_MS) return;
    this.lastTouch.set(user.sub, now);
    const params = {
      subject: user.sub,
      roles: user.roles.join(','),
      hospitalID: user.hospitalID || null,
      providerID: user.providerID || null,
      now: new Date(now).toISOString(),
    };
    const result = this.sql.seen.run(params);
    if (result.changes === 0) {
      this.sql.insert.run({ ...params, displayName: null, source: 'seen', createdBy: null, lastSeenAt: params.now });
    }
  }

  create({ subject, displayName, roles, hospitalID, providerID }, { createdBy } = {}) {
    const clean = this._validate({ subject, displayName, roles, hospitalID, providerID });
    if (this.sql.get.get(clean.subject)) {
      const err = new Error(`a user with ID "${clean.subject}" already exists`);
      err.status = 409;
      throw err;
    }
    this.sql.insert.run({ ...clean, source: 'created', now: new Date().toISOString(), createdBy: createdBy || null, lastSeenAt: null });
    return this.get(clean.subject);
  }

  update(subject, input) {
    const row = this.sql.get.get(subject);
    if (!row) return null;
    const current = this._fromRow(row);
    const clean = this._validate({ ...current, ...input, subject });
    this.sql.update.run(clean);
    return this.get(subject);
  }

  setStatus(subject, status) {
    if (!['active', 'disabled'].includes(status)) {
      const err = new Error('status must be active or disabled');
      err.status = 400;
      throw err;
    }
    if (!this.sql.get.get(subject)) {
      // A clinician or patient known only from the registry: give them a row.
      const known = this.list().find((u) => u.subject === subject);
      if (!known) return null;
      this.sql.insert.run({
        subject,
        displayName: known.displayName || null,
        roles: known.roles.join(','),
        hospitalID: known.hospitalID || null,
        providerID: known.providerID || null,
        source: 'created',
        now: new Date().toISOString(),
        createdBy: 'status-change',
        lastSeenAt: null,
      });
    }
    this.sql.setStatus.run(status, subject);
    this.lastTouch.delete(subject);
    return this.get(subject);
  }

  get(subject) {
    return this.list().find((u) => u.subject === subject) || null;
  }

  /** All users, merged from the users table, the provider registry and DID bindings. */
  list() {
    const bySubject = new Map(this.sql.all.all().map((r) => [r.subject, this._fromRow(r)]));

    for (const b of this.sql.bindings.all()) {
      const u = bySubject.get(b.subject);
      if (u) {
        u.patientDID = b.patient_did;
        if (!u.roles.includes(ROLES.PATIENT)) u.roles.push(ROLES.PATIENT);
      } else {
        bySubject.set(b.subject, {
          subject: b.subject,
          displayName: null,
          roles: [ROLES.PATIENT],
          hospitalID: null,
          providerID: null,
          patientDID: b.patient_did,
          status: 'active',
          source: 'patient-registration',
          createdAt: b.bound_at,
          createdBy: null,
          lastSeenAt: null,
        });
      }
    }

    for (const p of this.sql.providers.all()) {
      let data = {};
      try {
        data = JSON.parse(p.data);
      } catch {
        // malformed row: show what we have
      }
      // Clinicians sign in with their provider ID as subject in local mode;
      // in OIDC the provider_id claim links them.
      const match = [...bySubject.values()].find(
        (u) => u.providerID === p.provider_id && (!u.hospitalID || u.hospitalID === p.hospital_id)
      ) || bySubject.get(p.provider_id);
      if (match) {
        match.displayName = match.displayName || data.name || null;
        match.providerID = match.providerID || p.provider_id;
        match.hospitalID = match.hospitalID || p.hospital_id;
        match.department = data.department || null;
        match.registryStatus = p.status;
        if (!match.roles.includes(ROLES.CLINICIAN)) match.roles.push(ROLES.CLINICIAN);
      } else {
        bySubject.set(p.provider_id, {
          subject: p.provider_id,
          displayName: data.name || null,
          roles: [ROLES.CLINICIAN],
          hospitalID: p.hospital_id,
          providerID: p.provider_id,
          patientDID: null,
          department: data.department || null,
          registryStatus: p.status,
          status: 'active',
          source: 'provider-registry',
          createdAt: p.registered_at,
          createdBy: null,
          lastSeenAt: null,
        });
      }
    }

    return [...bySubject.values()].sort((a, b) => a.subject.localeCompare(b.subject));
  }

  _validate({ subject, displayName, roles, hospitalID, providerID }) {
    const fail = (message) => {
      const err = new Error(message);
      err.status = 400;
      throw err;
    };
    subject = String(subject || '').trim();
    if (!SUBJECT_PATTERN.test(subject)) fail('user ID is required: letters, digits and . _ - @ : (max 128)');
    const list = (Array.isArray(roles) ? roles : String(roles || '').split(',')).map((r) => r.trim()).filter(Boolean);
    if (!list.length) fail('at least one role is required');
    for (const r of list) if (!ALL_ROLES.has(r)) fail(`unknown role "${r}"`);
    hospitalID = String(hospitalID || '').trim() || null;
    if (list.some((r) => STAFF_ROLES.has(r)) && !hospitalID) fail('hospital staff need a hospital');
    providerID = String(providerID || '').trim() || null;
    if (list.includes(ROLES.CLINICIAN) && !providerID) providerID = subject;
    return {
      subject,
      displayName: String(displayName || '').trim().slice(0, 120) || null,
      roles: [...new Set(list)].join(','),
      hospitalID,
      providerID,
    };
  }

  _fromRow(r) {
    return {
      subject: r.subject,
      displayName: r.display_name,
      roles: r.roles ? r.roles.split(',').filter(Boolean) : [],
      hospitalID: r.hospital_id,
      providerID: r.provider_id,
      patientDID: null,
      status: r.status,
      source: r.source,
      createdAt: r.created_at,
      createdBy: r.created_by,
      lastSeenAt: r.last_seen_at,
    };
  }
}

module.exports = { UserDirectory };
