'use strict';

const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { grantMessage, revokeMessage, verifyPatientSignature } = require('./patientSignature');
const { BREAK_GLASS_MINUTES, BREAK_GLASS_MAX_MINUTES, EMERGENCY_SCOPE } = require('./emergencyPolicy');

const OWN_HOSPITAL = "a hospital's own records are not shared through Cevruni; its staff use the hospital's own EMR";

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
    // Pushes each event to subscribers (the SSE stream), the simulator's
    // equivalent of Fabric chaincode events.
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  /** Subscribe to ledger events; returns an unsubscribe function. */
  onEvent(listener) {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  _bump(category) {
    this.counters[category] += 1;
  }

  _emit(type, payload) {
    const evt = { type, payload, timestamp: new Date().toISOString() };
    this.eventLog.push(evt);
    if (this.eventLog.length > 500) this.eventLog.shift();
    this.events.emit('event', evt);
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
  requestAccess({ grantID, patientDID, providerID, hospitalID, scope, purpose, providerRole, requesterHospitalID }) {
    if (requesterHospitalID === hospitalID) throw new Error(OWN_HOSPITAL);
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
      providerRole: providerRole || '',
      requesterHospitalID: requesterHospitalID || '',
      patientSigned: false,
      revokeSigned: false,
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
  breakGlassAccess({ grantID, patientDID, providerID, hospitalID, requesterHospitalID, justification, representativeHash }) {
    if (!justification || !justification.trim()) {
      throw new Error('a justification is required for break-glass access');
    }
    if (!requesterHospitalID || requesterHospitalID === hospitalID) {
      throw new Error("break-glass is for another hospital's records; a hospital's own records are in its own EMR");
    }
    const id = grantID || randomUUID();
    if (this.grants.has(id)) throw new Error(`grant ${id} already exists`);
    const now = new Date();
    const expires = new Date(now.getTime() + BREAK_GLASS_MINUTES * 60000);
    const grant = {
      docType: 'grant',
      grantID: id,
      patientDID,
      providerID,
      hospitalID,
      grantType: 'BREAK_GLASS',
      scope: [...EMERGENCY_SCOPE],
      purpose: 'Emergency',
      justification: justification.trim(),
      requesterHospitalID,
      representativeHash: representativeHash || '',
      extensions: [],
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

  /** Extends an active emergency window, with a reason, up to 24 h in total. */
  extendBreakGlass({ grantID, providerID, reason, minutes }) {
    const grant = this.grants.get(grantID);
    if (!grant) throw new Error(`grant ${grantID} not found`);
    if (grant.grantType !== 'BREAK_GLASS') throw new Error(`grant ${grantID} is not a break-glass grant`);
    if (grant.providerID !== providerID) throw new Error('only the clinician who opened emergency access can extend it');
    if (!reason || !String(reason).trim()) throw new Error('a reason is required to extend emergency access');
    if (!(minutes > 0 && minutes <= BREAK_GLASS_MINUTES)) throw new Error(`an extension is 1 to ${BREAK_GLASS_MINUTES} minutes`);
    const now = new Date();
    const expires = new Date(grant.expiresAt);
    if (grant.status !== 'ACTIVE' || now > expires) throw new Error('emergency access has ended; invoke break-glass again if still needed');
    const limit = new Date(new Date(grant.grantedAt).getTime() + BREAK_GLASS_MAX_MINUTES * 60000);
    let next = new Date(expires.getTime() + minutes * 60000);
    if (next > limit) {
      if (expires >= limit) throw new Error("emergency access has reached the 24-hour limit; the patient's own permission is needed now");
      next = limit;
    }
    grant.expiresAt = next.toISOString();
    grant.extensions = [...(grant.extensions || []), { at: now.toISOString(), by: providerID, minutes, reason: String(reason).trim(), expiresAt: grant.expiresAt }];
    this._emit('BreakGlassExtended', grant);
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

  // Checks everything GrantAccess would, without changing state, and
  // returns a function that applies the approval -- so a batch can be
  // validated in full before any grant changes (all-or-nothing, like a
  // Fabric transaction).
  _prepareApproval({ grantID, durationMinutes, signature }) {
    const grant = this.grants.get(grantID);
    if (!grant) throw new Error(`grant ${grantID} not found`);
    if (grant.status !== 'PENDING') {
      throw new Error(`grant ${grantID} is not in PENDING state (current: ${grant.status})`);
    }
    if (!(durationMinutes > 0)) throw new Error('durationMinutes must be positive');
    const signed = verifyPatientSignature(this.patients.get(grant.patientDID), grantMessage(grantID, durationMinutes), signature);
    return () => {
      const now = new Date();
      grant.status = 'ACTIVE';
      grant.grantedAt = now.toISOString();
      grant.expiresAt = new Date(now.getTime() + durationMinutes * 60000).toISOString();
      grant.patientSigned = signed;
      return grant;
    };
  }

  grantAccess({ grantID, durationMinutes, signature }) {
    const grant = this._prepareApproval({ grantID, durationMinutes, signature })();
    this._bump('grant');
    this._emit('AccessGranted', grant);
    return grant;
  }

  /** Approves several pending grants as ONE transaction (Section 3.4.4). */
  grantAccessBatch(items) {
    if (!Array.isArray(items) || !items.length) throw new Error('batch is empty');
    if (items.length > 50) throw new Error('batch too large (max 50)');
    const ids = new Set();
    for (const it of items) {
      if (ids.has(it.grantID)) throw new Error(`grant ${it.grantID} appears twice in the batch`);
      ids.add(it.grantID);
    }
    const apply = items.map((it) => this._prepareApproval(it));
    const granted = apply.map((fn) => ({ ...fn() }));
    this._bump('grant'); // one transaction
    this._emit('AccessGrantedBatch', granted);
    return granted;
  }

  revokeAccess({ grantID, signature }) {
    const grant = this.grants.get(grantID);
    if (!grant) throw new Error(`grant ${grantID} not found`);
    // ACTIVE: revoke. PENDING: the patient declines the request.
    if (grant.status !== 'ACTIVE' && grant.status !== 'PENDING') {
      throw new Error(`grant ${grantID} is not ACTIVE or PENDING (current: ${grant.status})`);
    }
    grant.revokeSigned = verifyPatientSignature(this.patients.get(grant.patientDID), revokeMessage(grantID), signature);
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

  getGrantsByRequesterHospital(hospitalID) {
    return Array.from(this.grants.values())
      .filter((g) => g.requesterHospitalID === hospitalID)
      .map((g) => this.checkAccess({ grantID: g.grantID }))
      .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  }

  getAuditTrailForActor(actorID) {
    return Array.from(this.audit.values())
      .filter((e) => e.actorID === actorID)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  getGrantsForProvider(providerID) {
    return Array.from(this.grants.values())
      .filter((g) => g.providerID === providerID)
      .map((g) => this.checkAccess({ grantID: g.grantID }))
      .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  }

  getGrantsForHospital(hospitalID) {
    return Array.from(this.grants.values())
      .filter((g) => g.hospitalID === hospitalID)
      .map((g) => this.checkAccess({ grantID: g.grantID }))
      .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  }

  getAuditTrailForHospital(hospitalID) {
    return Array.from(this.audit.values())
      .filter((e) => e.hospitalID === hospitalID)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
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
