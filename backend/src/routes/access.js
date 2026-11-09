'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const { ROLES, hasRole, actsForHospital, isPatientSelf, isProvider, isSystemAdmin, deny, actorID } = require('../auth/policy');

function accessRouter(ledgerPromise, offlineQueue) {
  const router = express.Router();

  async function loadGrant(grantID) {
    const ledger = await ledgerPromise;
    try {
      return await ledger.checkAccess({ grantID });
    } catch {
      return null;
    }
  }

  /** Who may read a grant: its patient, its clinician, its hospital's admins. */
  function canSeeGrant(user, grant) {
    return (
      isPatientSelf(user, grant.patientDID) ||
      isProvider(user, grant.providerID, grant.hospitalID) ||
      actsForHospital(user, grant.hospitalID, ROLES.HOSPITAL_ADMIN)
    );
  }

  // A clinician's system requests access to a patient's records
  // (Figure 3, step 3 initiation). scope (an array of FHIR resource
  // types, e.g. ["Observation","MedicationRequest"]) and purpose
  // implement docs/design.md Section 8 and Section 35.1 -- both optional,
  // so a caller that omits them gets the previous full-scope behaviour.
  router.post('/request', async (req, res) => {
    try {
      const { patientDID, providerID, hospitalID, scope, purpose } = req.body;
      if (!patientDID || !providerID || !hospitalID) {
        return res.status(400).json({ error: 'patientDID, providerID and hospitalID are required' });
      }
      if (!isProvider(req.user, providerID, hospitalID)) {
        return deny(res, 'clinicians can only request access as themselves, for their own hospital');
      }
      const grantID = req.body.grantID || randomUUID();

      if (!offlineQueue.isConnected()) {
        const queued = offlineQueue.enqueue('REQUEST_ACCESS', { grantID, patientDID, providerID, hospitalID, scope, purpose });
        return res.status(202).json({ queued: true, queueItem: queued });
      }

      const ledger = await ledgerPromise;
      const grant = await ledger.requestAccess({ grantID, patientDID, providerID, hospitalID, scope, purpose });
      res.status(201).json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Emergency override access (docs/design.md Section 35.1 "break-glass"):
  // active immediately, no patient-approval step, but requires a
  // justification and is always flagged for mandatory post-hoc review.
  router.post('/break-glass', async (req, res) => {
    try {
      const { patientDID, providerID, hospitalID, justification } = req.body;
      if (!patientDID || !providerID || !hospitalID || !justification) {
        return res.status(400).json({ error: 'patientDID, providerID, hospitalID and justification are required' });
      }
      if (!isProvider(req.user, providerID, hospitalID)) {
        return deny(res, 'clinicians can only invoke break-glass as themselves, for their own hospital');
      }
      const grantID = req.body.grantID || randomUUID();

      const ledger = await ledgerPromise;
      const grant = await ledger.breakGlassAccess({ grantID, patientDID, providerID, hospitalID, justification });

      await ledger.writeAuditEntry({
        patientDID: grant.patientDID,
        eventType: 'BREAK_GLASS_ACCESS',
        actorID: grant.providerID,
        hospitalID: grant.hospitalID,
        detail: justification,
        clientTimestamp: new Date().toISOString(),
        queuedOffline: false,
      });

      res.status(201).json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Mandatory post-hoc review of a break-glass access, e.g. by a hospital
  // administrator (Section 35.1).
  router.post('/:grantID/review', async (req, res) => {
    try {
      const { notes } = req.body;
      // The reviewer is the authenticated admin, never a free-text field.
      const reviewerID = actorID(req.user, req.body.reviewerID);
      if (!reviewerID) {
        return res.status(400).json({ error: 'reviewerID is required' });
      }
      const existing = await loadGrant(req.params.grantID);
      if (!existing) return res.status(404).json({ error: 'grant not found' });
      if (!actsForHospital(req.user, existing.hospitalID, ROLES.HOSPITAL_ADMIN)) {
        return deny(res, 'only an admin of the hospital that used break-glass can review it');
      }
      if (!req.user.superuser && existing.providerID === req.user.providerID) {
        return deny(res, 'a clinician cannot review their own break-glass access');
      }
      const ledger = await ledgerPromise;
      const grant = await ledger.reviewBreakGlass({ grantID: req.params.grantID, reviewerID, notes });

      await ledger.writeAuditEntry({
        patientDID: grant.patientDID,
        eventType: 'BREAK_GLASS_REVIEWED',
        actorID: reviewerID,
        hospitalID: grant.hospitalID,
        detail: notes || '',
        clientTimestamp: new Date().toISOString(),
        queuedOffline: false,
      });

      res.json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Hospital admin's review queue.
  router.get('/break-glass/pending', async (req, res) => {
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    try {
      const ledger = await ledgerPromise;
      const pending = (await ledger.getPendingBreakGlassReviews()) || [];
      // Hospital admins see their own hospital's queue only.
      res.json(req.user.superuser || isSystemAdmin(req.user) ? pending : pending.filter((g) => g.hospitalID === req.user.hospitalID));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Patient approves a pending request with a configurable time limit.
  router.post('/:grantID/grant', async (req, res) => {
    try {
      const durationMinutes = Number(req.body.durationMinutes || 60);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 60 * 24 * 365) {
        return res.status(400).json({ error: 'durationMinutes must be between 1 and 525600' });
      }
      // Offline, the ledger can't be asked who owns the grant; the queued
      // action carries the patient's DID and is checked on replay.
      const actorPatientDID = req.user.superuser ? undefined : req.user.patientDID;
      if (!req.user.superuser && !hasRole(req.user, ROLES.PATIENT)) return deny(res, 'only the patient can approve access');

      if (!offlineQueue.isConnected()) {
        const queued = offlineQueue.enqueue('GRANT_ACCESS', { grantID: req.params.grantID, durationMinutes, actorPatientDID });
        return res.status(202).json({ queued: true, queueItem: queued });
      }

      const pendingGrant = await loadGrant(req.params.grantID);
      if (!pendingGrant) return res.status(404).json({ error: 'grant not found' });
      if (!isPatientSelf(req.user, pendingGrant.patientDID)) return deny(res, 'only the patient can approve access to their records');
      const ledger = await ledgerPromise;
      const grant = await ledger.grantAccess({ grantID: req.params.grantID, durationMinutes });

      await ledger.writeAuditEntry({
        patientDID: grant.patientDID,
        eventType: 'GRANT_ISSUED',
        actorID: grant.patientDID,
        hospitalID: grant.hospitalID,
        detail: `Access granted to ${grant.providerID} for ${durationMinutes} minutes`,
        clientTimestamp: new Date().toISOString(),
        queuedOffline: false,
      });

      res.json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Patient revokes at any time.
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
        });
        return res.status(202).json({ queued: true, queueItem: queued });
      }

      const current = await loadGrant(req.params.grantID);
      if (!current) return res.status(404).json({ error: 'grant not found' });
      if (!isPatientSelf(req.user, current.patientDID)) return deny(res, 'only the patient can revoke access to their records');
      const ledger = await ledgerPromise;
      const grant = await ledger.revokeAccess({ grantID: req.params.grantID });

      await ledger.writeAuditEntry({
        patientDID: grant.patientDID,
        eventType: 'GRANT_REVOKED',
        actorID: grant.patientDID,
        hospitalID: grant.hospitalID,
        detail: `Access revoked from ${grant.providerID}`,
        clientTimestamp: new Date().toISOString(),
        queuedOffline: false,
      });

      res.json(grant);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:grantID', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const grant = await ledger.checkAccess({ grantID: req.params.grantID });
      if (!canSeeGrant(req.user, grant)) return deny(res);
      res.json(grant);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.get('/patient/:did', async (req, res) => {
    if (!isPatientSelf(req.user, req.params.did) && !hasRole(req.user, ROLES.SYSTEM_ADMIN)) return deny(res);
    try {
      const ledger = await ledgerPromise;
      const grants = await ledger.getGrantsForPatient(req.params.did);
      res.json(grants || []);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { accessRouter };
