'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const { ROLES, hasRole, actsForHospital, isPatientSelf, isSystemAdmin, deny, actorID } = require('../auth/policy');
const { EmergencyDetails } = require('../services/emergencyDetails');
const { BREAK_GLASS_MINUTES } = require('../services/emergencyPolicy');

/**
 * access.js — access between facilities (Sections 3.4.1, 3.4.7).
 *
 * Cevruni is not an EMR. A hospital's own staff read that hospital's own
 * records in its own EMR, without Cevruni. Cevruni only mediates a clinician
 * at one hospital (the requesting hospital) seeing records held at ANOTHER
 * hospital (the record-holding hospital), and only when the patient has
 * both hospitals in their network (linked to their Health ID). Records are
 * fetched live from the holding hospital and never copied to the other.
 *
 * Two ways in:
 *   - a patient-approved grant: the clinician requests records from one of
 *     the patient's other hospitals; the patient approves (signed) or declines;
 *   - break-glass: in an emergency, a clinician uses the patient's hospital
 *     number at the other hospital (e.g. given by family) to open the
 *     emergency subset of records for one hour, extendable with a reason to
 *     24 hours, visible to both hospitals' admins and to the patient.
 */
const HOSPITAL_STAFF = 'hospital-staff@';

function accessRouter(ledgerPromise, offlineQueue, providerRegistry = null, fhirAdapter = null, { db = null, cipher = null, hospitalRegistry = null } = {}) {
  const router = express.Router();
  const emergency = db && cipher ? new EmergencyDetails({ db, cipher }) : null;

  async function loadGrant(grantID) {
    const ledger = await ledgerPromise;
    try {
      return await ledger.checkAccess({ grantID });
    } catch {
      return null;
    }
  }

  /** The hospitals a patient has in their network (linked to their Health ID). */
  function networkOf(patientDID) {
    return fhirAdapter ? fhirAdapter.listLinksForPatient(patientDID).map((l) => l.hospitalID) : [];
  }

  function hospitalName(id) {
    const h = hospitalRegistry ? hospitalRegistry.get(id) : null;
    return h ? h.name : id;
  }

  /**
   * The requesting (viewing) hospital for this caller: the clinician's own
   * hospital from their token. Without authentication (demo/evaluation),
   * the body may name it, or it is the provider's registered hospital.
   */
  function requesterOf(req, providerID) {
    if (!req.user.superuser) return req.user.hospitalID || null;
    if (req.body && req.body.requesterHospitalID) return req.body.requesterHospitalID;
    const regs = providerRegistry ? providerRegistry.registrationsOf(providerID) : [];
    return regs.length ? regs[0].hospitalID : null;
  }

  /** Who may read a grant: its patient, its clinician(s), and both hospitals' admins. */
  function canSeeGrant(user, grant) {
    if (isPatientSelf(user, grant.patientDID)) return true;
    if (user.superuser || isSystemAdmin(user)) return true;
    if (hasRole(user, ROLES.CLINICIAN) && user.hospitalID === grant.requesterHospitalID &&
        (grant.providerID === user.providerID || grant.providerID === `${HOSPITAL_STAFF}${user.hospitalID}`)) return true;
    return [grant.hospitalID, grant.requesterHospitalID].some((h) => h && actsForHospital(user, h, ROLES.HOSPITAL_ADMIN));
  }

  /** A grant with its off-chain emergency notes filled in, for display. */
  function emergencyView(g) {
    return emergency ? emergency.enrich(g) : g;
  }

  async function audit(ledger, entry) {
    return ledger.writeAuditEntry({ clientTimestamp: new Date().toISOString(), queuedOffline: false, ...entry });
  }

  // ── Requests between facilities ──────────────────────────────────────

  // A clinician asks the patient for records held at another hospital in
  // the patient's network. body: { patientDID, providerID, hospitalID (the
  // record-holding hospital), scope, purpose }.
  router.post('/request', async (req, res) => {
    try {
      const { patientDID, providerID, hospitalID, scope, purpose } = req.body || {};
      if (!patientDID || !providerID || !hospitalID) {
        return res.status(400).json({ error: 'patientDID, providerID and hospitalID (the hospital holding the records) are required' });
      }
      const requesterHospitalID = requesterOf(req, providerID);
      if (!req.user.superuser && !(hasRole(req.user, ROLES.CLINICIAN) && req.user.providerID === providerID)) {
        return deny(res, 'clinicians can only request access as themselves');
      }
      if (!requesterHospitalID) return res.status(400).json({ error: 'the requesting clinician has no hospital' });
      if (requesterHospitalID === hospitalID) {
        return res.status(400).json({ error: "your own hospital's records are in your hospital's EMR; Cevruni is for records held at other hospitals" });
      }
      if (fhirAdapter) {
        const network = networkOf(patientDID);
        if (!network.includes(requesterHospitalID) || !network.includes(hospitalID)) {
          return res.status(409).json({ error: `the patient's Cevruni network must include both ${hospitalName(requesterHospitalID)} and ${hospitalName(hospitalID)}` });
        }
      }
      const registered = providerRegistry ? providerRegistry.get(providerID, requesterHospitalID) : null;
      const providerRole = (registered && registered.role) || req.body.providerRole || '';
      const grantID = req.body.grantID || randomUUID();
      const payload = { grantID, patientDID, providerID, hospitalID, scope, purpose, providerRole, requesterHospitalID };

      if (!offlineQueue.isConnected()) {
        return res.status(202).json({ queued: true, queueItem: offlineQueue.enqueue('REQUEST_ACCESS', payload) });
      }
      const ledger = await ledgerPromise;
      res.status(201).json(await ledger.requestAccess(payload));
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // ── Break-glass ──────────────────────────────────────────────────────

  // body: { hospitalID (record-holding hospital), hospitalNumber (the
  // patient's number THERE, e.g. from family), justification,
  // representative?: { name, relationship, phone }, providerID }
  // Without authentication, patientDID may be given instead of the number.
  router.post('/break-glass', async (req, res) => {
    try {
      const body = req.body || {};
      if (!req.user.superuser && !hasRole(req.user, ROLES.CLINICIAN)) return deny(res, 'only clinicians can invoke emergency access');
      const providerID = req.user.superuser ? body.providerID : req.user.providerID;
      const { hospitalID, justification } = body;
      if (!providerID || !hospitalID || !justification || !String(justification).trim()) {
        return res.status(400).json({ error: 'hospitalID (the hospital holding the records), the patient\'s hospital number there and a justification are required' });
      }
      const requesterHospitalID = requesterOf(req, providerID);
      if (!requesterHospitalID) return res.status(400).json({ error: 'the requesting clinician has no hospital' });
      if (requesterHospitalID === hospitalID) {
        return res.status(400).json({ error: "your own hospital's records are in your hospital's EMR; break-glass is for records held at other hospitals" });
      }
      if (providerRegistry && !req.user.superuser && !providerRegistry.isAuthorized(providerID, requesterHospitalID)) {
        return deny(res, 'only active clinicians registered at your hospital can invoke emergency access');
      }

      // Find the patient by their number at the record-holding hospital.
      let patientDID = null;
      if (body.hospitalNumber && fhirAdapter) patientDID = fhirAdapter.findDidByHospitalNumber(hospitalID, String(body.hospitalNumber).trim());
      else if (req.user.superuser) patientDID = body.patientDID || null;
      if (!patientDID) {
        return res.status(404).json({ error: 'No Cevruni patient with that hospital number at that hospital' });
      }
      if (fhirAdapter) {
        const network = networkOf(patientDID);
        if (!network.includes(requesterHospitalID)) {
          return res.status(409).json({
            error: `this patient has not added ${hospitalName(requesterHospitalID)} to their Cevruni network, so their records at ${hospitalName(hospitalID)} cannot be opened from here. Treat with the information available (NHA 2014 s.20 still applies).`,
          });
        }
      }

      const representative = EmergencyDetails.clean(body.representative);
      const grantID = body.grantID || randomUUID();
      // The reason and who asked stay off-chain; the ledger gets their hash.
      const reason = String(justification).trim();
      const ref = emergency ? emergency.put(grantID, 'justification', { justification: reason, representative }) : reason;

      const ledger = await ledgerPromise;
      const grant = emergencyView(await ledger.breakGlassAccess({
        grantID, patientDID, providerID, hospitalID, requesterHospitalID,
        justification: ref, representativeHash: representative && emergency ? ref.slice(7) : '',
      }));

      await audit(ledger, {
        patientDID, eventType: 'BREAK_GLASS_ACCESS', actorID: providerID, hospitalID,
        detail: `Emergency access from ${hospitalName(requesterHospitalID)}; reason${representative ? ' and requesting representative' : ''} recorded off-chain (${emergency ? ref.slice(0, 19) : 'inline'})`,
      });

      const record = fhirAdapter ? fhirAdapter.listLinksForPatient(patientDID).find((l) => l.hospitalID === hospitalID) : null;
      const roster = record && fhirAdapter.findLocalPatientRecord(hospitalID, record.hospitalNumber);
      res.status(201).json({
        ...grant,
        patientName: roster ? roster.name : null,
        hospitalNumber: record ? record.hospitalNumber : null,
        representative: representative || null,
      });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Extend an emergency window: same clinician, a reason, up to 60 minutes
  // at a time and 24 hours in total.
  router.post('/:grantID/extend', async (req, res) => {
    try {
      const { reason } = req.body || {};
      const minutes = Number((req.body || {}).minutes || BREAK_GLASS_MINUTES);
      const current = await loadGrant(req.params.grantID);
      if (!current) return res.status(404).json({ error: 'grant not found' });
      const providerID = req.user.superuser ? current.providerID : req.user.providerID;
      if (!req.user.superuser && providerID !== current.providerID) return deny(res, 'only the clinician who opened emergency access can extend it');
      const text = String(reason || '').trim();
      if (!text) return res.status(400).json({ error: 'a reason is required to extend emergency access' });
      const ref = emergency ? emergency.put(req.params.grantID, 'extension', { reason: text }) : text;
      const ledger = await ledgerPromise;
      const grant = emergencyView(await ledger.extendBreakGlass({ grantID: req.params.grantID, providerID, reason: ref, minutes }));
      await audit(ledger, {
        patientDID: grant.patientDID, eventType: 'BREAK_GLASS_EXTENDED', actorID: providerID, hospitalID: grant.hospitalID,
        detail: `Emergency access extended by ${minutes} min to ${grant.expiresAt}; reason recorded off-chain (${emergency ? ref.slice(0, 19) : 'inline'})`,
      });
      res.json(grant);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // The representative behind an emergency access, for the patient, the
  // clinician and both hospitals' admins (GAID 2025 Art. 24(4)).
  router.get('/:grantID/emergency-details', async (req, res) => {
    const raw = await loadGrant(req.params.grantID);
    if (!raw) return res.status(404).json({ error: 'grant not found' });
    if (!canSeeGrant(req.user, raw)) return deny(res);
    const grant = emergencyView(raw);
    res.json({
      grantID: grant.grantID,
      justification: grant.justification || null,
      justificationVerified: grant.justificationVerified,
      extensions: grant.extensions || [],
      representative: grant.representative || null,
      recordsAt: { hospitalID: grant.hospitalID, name: hospitalName(grant.hospitalID) },
      viewedFrom: { hospitalID: grant.requesterHospitalID, name: hospitalName(grant.requesterHospitalID) },
    });
  });

  // Post-hoc review, by an admin of EITHER hospital involved (Section 3.4.7).
  router.post('/:grantID/review', async (req, res) => {
    try {
      const { notes } = req.body || {};
      const reviewerID = actorID(req.user, (req.body || {}).reviewerID);
      if (!reviewerID) return res.status(400).json({ error: 'reviewerID is required' });
      const existing = await loadGrant(req.params.grantID);
      if (!existing) return res.status(404).json({ error: 'grant not found' });
      const hospitals = [existing.hospitalID, existing.requesterHospitalID].filter(Boolean);
      if (!hospitals.some((h) => actsForHospital(req.user, h, ROLES.HOSPITAL_ADMIN))) {
        return deny(res, 'only an admin of one of the two hospitals involved can review an emergency access');
      }
      if (!req.user.superuser && existing.providerID === req.user.providerID) {
        return deny(res, 'a clinician cannot review their own break-glass access');
      }
      const ledger = await ledgerPromise;
      const grant = await ledger.reviewBreakGlass({ grantID: req.params.grantID, reviewerID, notes });
      const reviewerHospital = req.user.hospitalID ? hospitalName(req.user.hospitalID) : 'system admin';
      await audit(ledger, {
        patientDID: grant.patientDID, eventType: 'BREAK_GLASS_REVIEWED', actorID: reviewerID, hospitalID: grant.hospitalID,
        detail: `Reviewed by ${reviewerHospital}${notes ? `: ${notes}` : ''}`,
      });
      res.json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Review queue: emergency accesses to OR from the admin's hospital.
  router.get('/break-glass/pending', async (req, res) => {
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    try {
      const ledger = await ledgerPromise;
      const pending = (await ledger.getPendingBreakGlassReviews()) || [];
      const all = req.user.superuser || isSystemAdmin(req.user);
      const mine = all ? pending : pending.filter((g) => g.hospitalID === req.user.hospitalID || g.requesterHospitalID === req.user.hospitalID);
      res.json(mine.map((g) => ({
        ...emergencyView(g),
        recordsAtName: hospitalName(g.hospitalID),
        viewedFromName: hospitalName(g.requesterHospitalID),
        direction: g.hospitalID === req.user.hospitalID ? 'our-records' : g.requesterHospitalID === req.user.hospitalID ? 'our-clinician' : null,
      })));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Patient decisions ────────────────────────────────────────────────

  // Standing share: the patient lets every active clinician at one hospital
  // in their network see their records from another hospital in their
  // network. body: { viewerHospitalID, hospitalID (source), scope,
  // durationMinutes, grantID, signature }.
  router.post('/patient-grant', async (req, res) => {
    try {
      if (!hasRole(req.user, ROLES.PATIENT)) return deny(res, 'only patients can share their records');
      const { hospitalID, viewerHospitalID, durationMinutes, purpose, scope } = req.body || {};
      if (!hospitalID || !viewerHospitalID) return res.status(400).json({ error: 'hospitalID (whose records) and viewerHospitalID (who may see them) are required' });
      if (hospitalID === viewerHospitalID) return res.status(400).json({ error: 'choose two different hospitals' });
      const patientDID = req.user.superuser ? req.body.patientDID : req.user.patientDID;
      if (!patientDID) return res.status(400).json({ error: 'register your Health ID first' });
      const network = networkOf(patientDID);
      if (fhirAdapter && (!network.includes(hospitalID) || !network.includes(viewerHospitalID))) {
        return res.status(409).json({ error: 'both hospitals must be in your network (My Hospitals)' });
      }
      const duration = Number(durationMinutes || 1440);
      const grantID = typeof req.body.grantID === 'string' && /^[\w-]{8,64}$/.test(req.body.grantID) ? req.body.grantID : randomUUID();
      const ledger = await ledgerPromise;
      await ledger.requestAccess({
        grantID, patientDID, providerID: `${HOSPITAL_STAFF}${viewerHospitalID}`, hospitalID,
        scope: Array.isArray(scope) ? scope : [], purpose: purpose || 'Continuity of care', requesterHospitalID: viewerHospitalID,
      });
      const grant = await ledger.grantAccess({ grantID, durationMinutes: duration, signature: req.body.signature });
      await audit(ledger, {
        patientDID, eventType: 'PATIENT_GRANTED_HOSPITAL', actorID: patientDID, hospitalID,
        detail: `Patient shared ${hospitalName(hospitalID)} records with ${hospitalName(viewerHospitalID)} for ${duration} minutes`,
      });
      res.status(201).json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Kept for older clients: approve the request, then share the same
  // clinician the patient's records at further hospitals, all in one batch.
  router.post('/:grantID/approve-cross-hospital', async (req, res) => {
    try {
      if (!hasRole(req.user, ROLES.PATIENT)) return deny(res, 'only the patient can approve');
      const { targetHospitalIDs = [], durationMinutes } = req.body || {};
      const duration = Number(durationMinutes || 60);
      const pending = await loadGrant(req.params.grantID);
      if (!pending) return res.status(404).json({ error: 'grant not found' });
      if (!isPatientSelf(req.user, pending.patientDID)) return deny(res, 'only the patient can approve access to their records');
      const ledger = await ledgerPromise;
      const signed = new Map((Array.isArray(req.body.crossGrants) ? req.body.crossGrants : []).map((c) => [c.hospitalID, c]));
      const items = [{ grantID: req.params.grantID, durationMinutes: duration, signature: req.body.signature }];
      for (const target of targetHospitalIDs.filter((t) => t !== pending.hospitalID && t !== pending.requesterHospitalID)) {
        const s = signed.get(target);
        const id = s && /^[\w-]{8,64}$/.test(s.grantID || '') ? s.grantID : randomUUID();
        await ledger.requestAccess({
          grantID: id, patientDID: pending.patientDID, providerID: pending.providerID, hospitalID: target,
          scope: pending.scope, purpose: pending.purpose, providerRole: pending.providerRole || '', requesterHospitalID: pending.requesterHospitalID,
        });
        items.push({ grantID: id, durationMinutes: duration, signature: s && s.signature });
      }
      const results = items.length > 1 ? await ledger.grantAccessBatch(items) : [await ledger.grantAccess(items[0])];
      for (const g of results) {
        await audit(ledger, { patientDID: g.patientDID, eventType: 'GRANT_ISSUED', actorID: g.patientDID, hospitalID: g.hospitalID, detail: `Access to ${hospitalName(g.hospitalID)} records granted to ${g.providerID} for ${duration} minutes` });
      }
      res.json({ approved: results[0], crossGrants: results.slice(1) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Patient approves a pending request with a time limit (signed).
  router.post('/:grantID/grant', async (req, res) => {
    try {
      const durationMinutes = Number((req.body || {}).durationMinutes || 60);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 60 * 24 * 365) {
        return res.status(400).json({ error: 'durationMinutes must be between 1 and 525600' });
      }
      const actorPatientDID = req.user.superuser ? undefined : req.user.patientDID;
      if (!req.user.superuser && !hasRole(req.user, ROLES.PATIENT)) return deny(res, 'only the patient can approve access');
      if (!offlineQueue.isConnected()) {
        const queued = offlineQueue.enqueue('GRANT_ACCESS', { grantID: req.params.grantID, durationMinutes, actorPatientDID, signature: req.body.signature });
        return res.status(202).json({ queued: true, queueItem: queued });
      }
      const pending = await loadGrant(req.params.grantID);
      if (!pending) return res.status(404).json({ error: 'grant not found' });
      if (!isPatientSelf(req.user, pending.patientDID)) return deny(res, 'only the patient can approve access to their records');
      const ledger = await ledgerPromise;
      const grant = await ledger.grantAccess({ grantID: req.params.grantID, durationMinutes, signature: req.body.signature });
      await audit(ledger, {
        patientDID: grant.patientDID, eventType: 'GRANT_ISSUED', actorID: grant.patientDID, hospitalID: grant.hospitalID,
        detail: `Access to ${hospitalName(grant.hospitalID)} records granted to ${grant.providerID} (${hospitalName(grant.requesterHospitalID)}) for ${durationMinutes} minutes${grant.patientSigned ? ' (signed by patient)' : ''}`,
      });
      res.json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Patient revokes an active grant, or declines a pending request (signed).
  router.post('/:grantID/revoke', async (req, res) => {
    try {
      if (!req.user.superuser && !hasRole(req.user, ROLES.PATIENT)) return deny(res, 'only the patient can revoke access');
      if (!offlineQueue.isConnected()) {
        const queued = offlineQueue.enqueue('REVOKE_ACCESS', {
          grantID: req.params.grantID,
          patientDID: req.user.superuser ? req.body.patientDID : req.user.patientDID,
          hospitalID: req.body.hospitalID,
          actorID: actorID(req.user, req.body.actorID),
          actorPatientDID: req.user.superuser ? undefined : req.user.patientDID,
          signature: req.body.signature,
        });
        return res.status(202).json({ queued: true, queueItem: queued });
      }
      const current = await loadGrant(req.params.grantID);
      if (!current) return res.status(404).json({ error: 'grant not found' });
      if (!isPatientSelf(req.user, current.patientDID)) return deny(res, 'only the patient can revoke access to their records');
      const wasPending = current.status === 'PENDING';
      const ledger = await ledgerPromise;
      const grant = await ledger.revokeAccess({ grantID: req.params.grantID, signature: req.body.signature });
      await audit(ledger, {
        patientDID: grant.patientDID, eventType: 'GRANT_REVOKED', actorID: grant.patientDID, hospitalID: grant.hospitalID,
        detail: wasPending ? `Request from ${grant.providerID} declined` : `Access revoked from ${grant.providerID}`,
      });
      res.json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Patient approves several pending requests: ONE ledger transaction.
  router.post('/batch-grant', async (req, res) => {
    try {
      if (!req.user.superuser && !hasRole(req.user, ROLES.PATIENT)) return deny(res, 'only the patient can approve access');
      const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
      if (!items.length || items.length > 50) return res.status(400).json({ error: 'items must list 1-50 grants' });
      for (const it of items) {
        const d = Number(it.durationMinutes);
        if (typeof it.grantID !== 'string' || !Number.isFinite(d) || d <= 0 || d > 60 * 24 * 365) {
          return res.status(400).json({ error: 'each item needs a grantID and durationMinutes between 1 and 525600' });
        }
        it.durationMinutes = d;
      }
      if (!offlineQueue.isConnected()) {
        const queued = offlineQueue.enqueue('GRANT_ACCESS_BATCH', { items, actorPatientDID: req.user.superuser ? undefined : req.user.patientDID });
        return res.status(202).json({ queued: true, queueItem: queued });
      }
      for (const it of items) {
        const g = await loadGrant(it.grantID);
        if (!g) return res.status(404).json({ error: `grant ${it.grantID} not found` });
        if (!isPatientSelf(req.user, g.patientDID)) return deny(res, 'only the patient can approve access to their records');
      }
      const ledger = await ledgerPromise;
      const grants = await ledger.grantAccessBatch(items.map(({ grantID, durationMinutes, signature }) => ({ grantID, durationMinutes, signature })));
      for (const grant of grants) {
        await audit(ledger, {
          patientDID: grant.patientDID, eventType: 'GRANT_ISSUED', actorID: grant.patientDID, hospitalID: grant.hospitalID,
          detail: `Access to ${hospitalName(grant.hospitalID)} records granted to ${grant.providerID} for ${items.find((i) => i.grantID === grant.grantID).durationMinutes} minutes (batch of ${grants.length})${grant.patientSigned ? ' (signed by patient)' : ''}`,
        });
      }
      res.json({ grants, transactions: 1 });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Reads ────────────────────────────────────────────────────────────

  // The signed-in clinician's grants (their own, and their hospital's
  // standing shares), with the patient's name from the requesting
  // hospital's roster and both hospitals' names.
  router.get('/provider/me', async (req, res) => {
    if (!hasRole(req.user, ROLES.CLINICIAN)) return deny(res, 'requires clinician role');
    const providerID = req.user.superuser ? req.query.providerID : req.user.providerID;
    const home = req.user.superuser ? req.query.hospitalID : req.user.hospitalID;
    if (!providerID) return res.status(400).json({ error: 'no provider ID on this account' });
    try {
      const ledger = await ledgerPromise;
      const own = (await ledger.getGrantsForProvider(providerID)) || [];
      const shared = home ? (await ledger.getGrantsForProvider(`${HOSPITAL_STAFF}${home}`)) || [] : [];
      const grants = [...own, ...shared].filter((g) => !home || !g.requesterHospitalID || g.requesterHospitalID === home);
      res.json(
        grants.map((g) => {
          let patientName = null;
          let hospitalNumber = null;
          let localNumber = null;
          if (fhirAdapter) {
            const links = fhirAdapter.listLinksForPatient(g.patientDID);
            const atSource = links.find((l) => l.hospitalID === g.hospitalID);
            const atHome = links.find((l) => l.hospitalID === g.requesterHospitalID);
            hospitalNumber = atSource ? atSource.hospitalNumber : null;
            localNumber = atHome ? atHome.hospitalNumber : null;
            const pick = atHome || atSource;
            const rec = pick ? fhirAdapter.findLocalPatientRecord(pick.hospitalID, pick.hospitalNumber) : null;
            patientName = rec ? rec.name : null;
          }
          return {
            ...emergencyView(g), patientName, hospitalNumber, localNumber,
            recordsAtName: hospitalName(g.hospitalID), viewedFromName: hospitalName(g.requesterHospitalID),
            sharedWithHospital: g.providerID.startsWith(HOSPITAL_STAFF),
          };
        })
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:grantID', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const grant = await ledger.checkAccess({ grantID: req.params.grantID });
      if (!canSeeGrant(req.user, grant)) return deny(res);
      res.json(emergencyView(grant));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Older clinician view: their active grants for one patient at other hospitals.
  router.get('/my-grants/:did', async (req, res) => {
    if (!hasRole(req.user, ROLES.CLINICIAN)) return deny(res, 'requires clinician role');
    try {
      const ledger = await ledgerPromise;
      const all = (await ledger.getGrantsForPatient(req.params.did)) || [];
      res.json(all.filter((g) => g.providerID === req.user.providerID && g.status === 'ACTIVE' && g.hospitalID !== req.user.hospitalID));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/patient/:did', async (req, res) => {
    if (!isPatientSelf(req.user, req.params.did) && !hasRole(req.user, ROLES.SYSTEM_ADMIN)) return deny(res);
    try {
      const ledger = await ledgerPromise;
      const grants = (await ledger.getGrantsForPatient(req.params.did)) || [];
      res.json(grants.map((g) => ({ ...emergencyView(g), recordsAtName: hospitalName(g.hospitalID), viewedFromName: hospitalName(g.requesterHospitalID) })));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { accessRouter, HOSPITAL_STAFF };
