'use strict';

const { randomUUID } = require('crypto');

/**
 * simulatedLedgerService.js
 *
 * An in-memory stand-in for the Fabric chaincode, implementing the exact
 * same operations as patientregistry.go / accesscontrol.go / auditlog.go /
 * costmetrics.go. This lets the whole app run and be demoed with
 * `npm start` alone -- no Docker, no Fabric network -- which is useful for
 * day-to-day development and for a defense room without a live network.
 *
 * LEDGER_MODE=fabric switches server.js to fabricLedgerService.js instead,
 * which talks to the real deployed chaincode via the Fabric Gateway SDK.
 * Both modules implement the same method surface so routes never need to
 * know which one is active.
 */
class SimulatedLedgerService {
  constructor() {
    this.patients = new Map(); // patientDID -> patient
    this.references = new Map(); // refID -> reference
    this.referencesByPatient = new Map(); // patientDID -> Set(refID)
    this.grants = new Map(); // grantID -> grant
    this.grantsByPatient = new Map(); // patientDID -> Set(grantID)
    this.audit = new Map(); // entryID -> entry
    this.auditByPatient = new Map(); // patientDID -> [entryID] (insertion order)
    this.counters = { registration: 0, reference: 0, grant: 0, audit: 0, breakglass: 0 };
    this.eventLog = []; // for the demo's "live ledger events" feed
  }

  _bump(category) {
    this.counters[category] += 1;
  }

  _emit(type, payload) {
    const evt = { type, payload, timestamp: new Date().toISOString() };
    this.eventLog.push(evt);
    if (this.eventLog.length > 500) this.eventLog.shift();
    return evt;
  }

  // ---------- PatientRegistry ----------

  registerPatient({ patientDID, publicKey }) {
    if (!patientDID) throw new Error('patientDID must not be empty');
    if (this.patients.has(patientDID)) {
      throw new Error(`patient ${patientDID} is already registered`);
    }
    const patient = {
      docType: 'patient',
      patientDID,
      publicKey,
      registeredAt: new Date().toISOString(),
    };
    this.patients.set(patientDID, patient);
    this.referencesByPatient.set(patientDID, new Set());
    this.grantsByPatient.set(patientDID, new Set());
    this.auditByPatient.set(patientDID, []);
    this._bump('registration');
    this._emit('PatientRegistered', patient);
    return patient;
  }

  getPatient(patientDID) {
    const p = this.patients.get(patientDID);
    if (!p) throw new Error(`patient ${patientDID} not found`);
    return p;
  }

  registerRecordReference({ refID, patientDID, hospitalID, recordType, date, registeredBy }) {
    if (!this.patients.has(patientDID)) {
      throw new Error(`patient ${patientDID} is not registered`);
    }
    const id = refID || randomUUID();
    if (this.references.has(id)) throw new Error(`record reference ${id} already exists`);
    const ref = {
      docType: 'recordref',
      refID: id,
      patientDID,
      hospitalID,
      recordType,
      date: date || new Date().toISOString(),
      registeredBy: registeredBy || 'system',
    };
    this.references.set(id, ref);
    this.referencesByPatient.get(patientDID).add(id);
    this._bump('reference');
    this._emit('RecordReferenceRegistered', ref);
    return ref;
  }

  getRecordReferencesForPatient(patientDID) {
    const ids = this.referencesByPatient.get(patientDID) || new Set();
    return Array.from(ids).map((id) => this.references.get(id));
  }

  // ---------- AccessControl ----------

  // scope/purpose implement docs/design.md Section 8 (granular, FHIR-resource
  // -scoped authorization) and Section 35.1 (purpose-of-use limitation) --
  // both optional so requests that omit them keep behaving exactly as
  // before (full-scope, purpose defaults to "Treatment").
  requestAccess({ grantID, patientDID, providerID, hospitalID, scope, purpose }) {
    const id = grantID || randomUUID();
    if (this.grants.has(id)) throw new Error(`grant ${id} already exists`);
    const grant = {
      docType: 'grant',
      grantID: id,
      patientDID,
      providerID,
      hospitalID,
      grantType: 'STANDARD',
      scope: Array.isArray(scope) && scope.length ? scope : [],
      purpose: purpose || 'Treatment',
      status: 'PENDING',
      requestedAt: new Date().toISOString(),
      grantedAt: null,
      expiresAt: null,
      revokedAt: null,
      reviewRequired: false,
      reviewed: false,
    };
    this.grants.set(id, grant);
    if (!this.grantsByPatient.has(patientDID)) this.grantsByPatient.set(patientDID, new Set());
    this.grantsByPatient.get(patientDID).add(id);
    this._bump('grant');
    this._emit('AccessRequested', grant);
    return grant;
  }

  // BreakGlassAccess implements docs/design.md Section 35.1's emergency
  // override: it is ACTIVE the instant it is created (no patient approval
  // step), but is flagged distinctly from a normal grant and always
  // requires a post-hoc review.
  breakGlassAccess({ grantID, patientDID, providerID, hospitalID, justification }) {
    if (!justification || !justification.trim()) {
      throw new Error('a justification is required for break-glass access');
    }
    const id = grantID || randomUUID();
    if (this.grants.has(id)) throw new Error(`grant ${id} already exists`);
    const now = new Date();
    const expires = new Date(now.getTime() + 15 * 60000); // short default window, per Section 35.1
    const grant = {
      docType: 'grant',
      grantID: id,
      patientDID,
      providerID,
      hospitalID,
      grantType: 'BREAK_GLASS',
      scope: [],
      purpose: 'Emergency',
      justification: justification.trim(),
      status: 'ACTIVE',
      requestedAt: now.toISOString(),
      grantedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      revokedAt: null,
      reviewRequired: true,
      reviewed: false,
      reviewedAt: null,
      reviewedBy: null,
      reviewNotes: null,
    };
    this.grants.set(id, grant);
    if (!this.grantsByPatient.has(patientDID)) this.grantsByPatient.set(patientDID, new Set());
    this.grantsByPatient.get(patientDID).add(id);
    this._bump('grant');
    this._bump('breakglass');
    this._emit('BreakGlassAccess', grant);
    return grant;
  }

  // ReviewBreakGlass closes the mandatory post-hoc review loop -- it never
  // changes what the provider already saw, only records that a hospital
  // administrator (or the patient) has looked at why.
  reviewBreakGlass({ grantID, reviewerID, notes }) {
    const grant = this.grants.get(grantID);
    if (!grant) throw new Error(`grant ${grantID} not found`);
    if (grant.grantType !== 'BREAK_GLASS') {
      throw new Error(`grant ${grantID} is not a break-glass grant`);
    }
    if (grant.reviewed) {
      throw new Error(`grant ${grantID} has already been reviewed`);
    }
    grant.reviewed = true;
    grant.reviewedAt = new Date().toISOString();
    grant.reviewedBy = reviewerID;
    grant.reviewNotes = notes || '';
    this._emit('BreakGlassReviewed', grant);
    return grant;
  }

  getPendingBreakGlassReviews() {
    return Array.from(this.grants.values())
      .filter((g) => g.grantType === 'BREAK_GLASS' && g.reviewRequired && !g.reviewed)
      .sort((a, b) => new Date(b.grantedAt) - new Date(a.grantedAt));
  }

  grantAccess({ grantID, durationMinutes }) {
    const grant = this.grants.get(grantID);
    if (!grant) throw new Error(`grant ${grantID} not found`);
    if (grant.status !== 'PENDING') {
      throw new Error(`grant ${grantID} is not in PENDING state (current: ${grant.status})`);
    }
    if (!(durationMinutes > 0)) throw new Error('durationMinutes must be positive');
    const now = new Date();
    grant.status = 'ACTIVE';
    grant.grantedAt = now.toISOString();
    grant.expiresAt = new Date(now.getTime() + durationMinutes * 60000).toISOString();
    this._bump('grant');
    this._emit('AccessGranted', grant);
    return grant;
  }

  revokeAccess({ grantID }) {
    const grant = this.grants.get(grantID);
    if (!grant) throw new Error(`grant ${grantID} not found`);
    if (grant.status !== 'ACTIVE') {
      throw new Error(`grant ${grantID} is not ACTIVE (current: ${grant.status})`);
    }
    grant.status = 'REVOKED';
    grant.revokedAt = new Date().toISOString();
    this._bump('grant');
    this._emit('AccessRevoked', grant);
    return grant;
  }

  checkAccess({ grantID }) {
    const grant = this.grants.get(grantID);
    if (!grant) throw new Error(`grant ${grantID} not found`);
    if (grant.status === 'ACTIVE' && grant.expiresAt && new Date() > new Date(grant.expiresAt)) {
      grant.status = 'EXPIRED';
    }
    return grant;
  }

  getGrantsForPatient(patientDID) {
    const ids = this.grantsByPatient.get(patientDID) || new Set();
    return Array.from(ids)
      .map((id) => this.checkAccess({ grantID: id }))
      .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  }

  // ---------- AuditLog ----------

  writeAuditEntry({ entryID, patientDID, eventType, actorID, hospitalID, detail, clientTimestamp, queuedOffline }) {
    const id = entryID || randomUUID();
    if (this.audit.has(id)) throw new Error(`audit entry ${id} already exists`);
    const entry = {
      docType: 'audit',
      entryID: id,
      patientDID,
      eventType,
      actorID,
      hospitalID,
      timestamp: clientTimestamp || new Date().toISOString(),
      detail: detail || '',
      queuedOffline: !!queuedOffline,
    };
    this.audit.set(id, entry);
    if (!this.auditByPatient.has(patientDID)) this.auditByPatient.set(patientDID, []);
    this.auditByPatient.get(patientDID).push(id);
    this._bump('audit');
    this._emit('AuditEntryWritten', entry);
    return entry;
  }

  getAuditTrailForPatient(patientDID) {
    const ids = this.auditByPatient.get(patientDID) || [];
    return ids
      .map((id) => this.audit.get(id))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  // ---------- CostMetrics ----------

  getCounters() {
    return { ...this.counters };
  }

  getRecentEvents(limit = 50) {
    return this.eventLog.slice(-limit).reverse();
  }
}

module.exports = { SimulatedLedgerService };
