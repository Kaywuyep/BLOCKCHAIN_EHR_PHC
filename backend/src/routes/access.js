'use strict';

const express = require('express');
const { randomUUID } = require('crypto');

function accessRouter(ledgerPromise, offlineQueue) {
  const router = express.Router();

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
      const { reviewerID, notes } = req.body;
      if (!reviewerID) {
        return res.status(400).json({ error: 'reviewerID is required' });
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
    try {
      const ledger = await ledgerPromise;
      const pending = await ledger.getPendingBreakGlassReviews();
      res.json(pending || []);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Patient approves a pending request with a configurable time limit.
  router.post('/:grantID/grant', async (req, res) => {
    try {
      const durationMinutes = Number(req.body.durationMinutes || 60);

      if (!offlineQueue.isConnected()) {
        const queued = offlineQueue.enqueue('GRANT_ACCESS', { grantID: req.params.grantID, durationMinutes });
        return res.status(202).json({ queued: true, queueItem: queued });
      }

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
      if (!offlineQueue.isConnected()) {
        const queued = offlineQueue.enqueue('REVOKE_ACCESS', {
          grantID: req.params.grantID,
          patientDID: req.body.patientDID,
          hospitalID: req.body.hospitalID,
          actorID: req.body.actorID,
        });
        return res.status(202).json({ queued: true, queueItem: queued });
      }

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
      res.json(grant);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.get('/patient/:did', async (req, res) => {
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
